import {
  BadRequestException,
  Injectable,
  NotFoundException,
  Optional,
  type OnModuleDestroy,
} from '@nestjs/common';
import type { ModelOptionsMap } from '../models/model-options.types';
import { deriveHasPendingInput } from '../sessions/domain/derive-pending-input';
import { EventsRepository } from '../sessions/persistence/events.repository';
import { SessionsService } from '../sessions/sessions.service';
import { SettingsService } from '../settings/settings.service';
import { buildSubagentTaskInput } from './multitask-defaults';
import { TasksRepository } from './tasks.repository';
import {
  TERMINAL_TASK_STATUSES,
  type CreateTaskDto,
  type StartMultitaskDto,
  type StartMultitaskResultDto,
  type TaskDto,
} from './tasks.types';

/** How many trailing events to scan when deriving "waiting on user input". */
const PENDING_SCAN_TAIL = 200;

/** Launch-countdown bounds (seconds): long enough to react, short enough to matter. */
const MIN_HOLD_SECONDS = 5;
const MAX_HOLD_SECONDS = 600;
const DEFAULT_HOLD_SECONDS = 15;

function clampHoldSeconds(seconds: number): number {
  return Math.min(MAX_HOLD_SECONDS, Math.max(MIN_HOLD_SECONDS, seconds));
}

@Injectable()
export class TasksService implements OnModuleDestroy {
  /** Single wake timer that re-runs the pump when the earliest hold expires. */
  private holdTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;
  /**
   * Handlers invoked with the terminal TaskDto after a task settles on ANY path
   * (green / red / needs-attention / error). Lets the loop primitive fold a
   * settled loop-run without TasksService knowing about loops. Fired best-effort.
   */
  private readonly finishHandlers = new Set<(task: TaskDto) => void>();

  constructor(
    private readonly tasks: TasksRepository,
    private readonly sessions: SessionsService,
    private readonly events: EventsRepository,
    @Optional() private readonly settings?: SettingsService,
  ) {
    // A RUNNING row at boot means the runner died mid-task; its session was
    // already reconciled by the sessions sweep. Queued work simply resumes.
    this.tasks.failInterrupted('daemon_restart');
    void this.pump();
  }

  /** Register a task-settlement listener (e.g. the loop primitive). */
  onTaskFinished(handler: (task: TaskDto) => void): () => void {
    this.finishHandlers.add(handler);
    return () => this.finishHandlers.delete(handler);
  }

  /** One task by id, or null (used by consumers correlating settlement). */
  findById(id: string): TaskDto | null {
    return this.tasks.findById(id);
  }

  private notifyFinished(taskId: string): void {
    if (this.finishHandlers.size === 0) return;
    const task = this.tasks.findById(taskId);
    if (!task) return;
    for (const handler of this.finishHandlers) {
      try {
        handler(task);
      } catch {
        // A listener must never break the runner.
      }
    }
  }

  list(parentSessionId?: string): TaskDto[] {
    const tasks = parentSessionId
      ? this.tasks.listByParentSession(parentSessionId)
      : this.tasks.list();
    return tasks.map((task) => ({
      ...task,
      pendingInput:
        task.status === 'RUNNING' && task.sessionId
          ? deriveHasPendingInput(this.events.listTail(task.sessionId, PENDING_SCAN_TAIL))
          : false,
    }));
  }

  enqueue(input: CreateTaskDto): TaskDto {
    return this.enqueueMany([input])[0]!;
  }

  enqueueMany(inputs: CreateTaskDto[]): TaskDto[] {
    if (inputs.length === 0) return [];
    const normalized = inputs.map((input) => {
      const prompt = input.prompt?.trim();
      if (!prompt) throw new BadRequestException('prompt is required');
      return { ...input, prompt };
    });
    const tasks = this.tasks.createMany(normalized);
    void this.pump();
    return tasks;
  }

  startMultitask(input: StartMultitaskDto): StartMultitaskResultDto {
    const parentSessionId = input.parentSessionId?.trim();
    if (!parentSessionId) throw new BadRequestException('parentSessionId is required');
    const parent = this.sessions.get(parentSessionId);
    if (!parent) throw new NotFoundException('Parent session not found');

    const prompts = input.prompts
      ?.map((prompt) => prompt.trim())
      .filter(Boolean);
    if (!prompts?.length) throw new BadRequestException('at least one prompt is required');

    const tasks = prompts.map((prompt) =>
      this.enqueue({
        ...buildSubagentTaskInput(input, parent, prompt, this.settings),
        holdUntil: Date.now() + this.countdownMs(),
      }),
    );

    return { parentSessionId, tasks };
  }

  /**
   * Convert the parent session's pending steer queue into parallel subagents.
   * Draining the queue is what keeps each prompt from also being delivered
   * sequentially when the parent's run settles — otherwise every queued prompt
   * would run twice. Subagents inherit the parent's provider/model defaults.
   */
  startMultitaskFromQueue(parentSessionId: string): StartMultitaskResultDto {
    const trimmed = parentSessionId?.trim();
    if (!trimmed) throw new BadRequestException('parentSessionId is required');
    const parent = this.sessions.get(trimmed);
    if (!parent) throw new NotFoundException('Parent session not found');

    const prompts = this.sessions.drainSteerQueueForMultitask(trimmed);
    if (prompts.length === 0) {
      throw new BadRequestException('No queued messages to multitask');
    }

    const tasks = prompts.map((prompt) =>
      this.enqueue({
        ...buildSubagentTaskInput({ parentSessionId: trimmed, prompts }, parent, prompt, this.settings),
        holdUntil: Date.now() + this.countdownMs(),
      }),
    );

    return { parentSessionId: trimmed, tasks };
  }

  cancel(id: string): TaskDto {
    this.requireTask(id);
    const cancelled = this.tasks.cancel(id);
    if (!cancelled) {
      throw new BadRequestException('Only queued tasks can be cancelled');
    }
    // Cancel is a terminal settlement path — notify finish-hook consumers (a loop
    // folds the cancelled run to failed) exactly as DONE/FAILED do. Without this,
    // a cancelled loop task would leave its run pending forever, bricking the loop.
    this.notifyFinished(cancelled.id);
    return cancelled;
  }

  /** Explicit retry: clone a terminal task into a fresh queued run. */
  retry(id: string): TaskDto {
    const task = this.requireTask(id);
    if (!TERMINAL_TASK_STATUSES.includes(task.status)) {
      throw new BadRequestException('Only finished tasks can be retried');
    }
    return this.enqueue({
      prompt: task.prompt,
      ...(task.provider ? { provider: task.provider } : {}),
      ...(task.model ? { model: task.model } : {}),
      ...(task.modelOptions ? { modelOptions: task.modelOptions } : {}),
      ...(task.projectPath ? { projectPath: task.projectPath } : {}),
      ...(task.baseBranch ? { baseBranch: task.baseBranch } : {}),
      ...(task.useWorktree ? { useWorktree: true } : {}),
      ...(task.workspace ? { workspace: task.workspace } : {}),
      ...(task.parentSessionId ? { parentSessionId: task.parentSessionId } : {}),
      ...(task.role === 'subagent' ? { role: 'subagent' as const } : {}),
      ...(task.cleanupPolicy ? { cleanupPolicy: task.cleanupPolicy } : {}),
    });
  }

  markReviewed(id: string): TaskDto {
    this.requireTask(id);
    const reviewed = this.tasks.markReviewed(id);
    if (!reviewed) {
      throw new BadRequestException('Only finished subagents awaiting review can be marked reviewed');
    }
    return reviewed;
  }

  /**
   * Re-route or re-arm a task that is still queued (typically mid-hold). A hold
   * re-arm is only allowed while the task is actually holding — you cannot start
   * a countdown on a task that was never delayed.
   */
  update(
    id: string,
    input: { provider?: string; model?: string; modelOptions?: ModelOptionsMap | null; holdSeconds?: number },
  ): TaskDto {
    const task = this.requireTask(id);
    if (task.status !== 'QUEUED') {
      throw new BadRequestException('Only queued tasks can be updated');
    }

    // Validate at the boundary: a non-string provider/model or a non-finite
    // holdSeconds would otherwise persist as garbage — e.g. NaN is stored as
    // NULL by SQLite, silently un-holding the task without re-queuing a pump.
    if (input.provider !== undefined && typeof input.provider !== 'string') {
      throw new BadRequestException('provider must be a string');
    }
    if (input.model !== undefined && typeof input.model !== 'string') {
      throw new BadRequestException('model must be a string');
    }

    let holdUntil: number | undefined;
    if (input.holdSeconds !== undefined) {
      if (typeof input.holdSeconds !== 'number' || !Number.isFinite(input.holdSeconds)) {
        throw new BadRequestException('holdSeconds must be a number');
      }
      if (task.holdUntil == null) {
        throw new BadRequestException('Task is not holding');
      }
      holdUntil = Date.now() + clampHoldSeconds(input.holdSeconds) * 1000;
    }

    const updated = this.tasks.updateWhileQueued(id, {
      ...(input.provider !== undefined ? { provider: input.provider } : {}),
      ...(input.model !== undefined ? { model: input.model } : {}),
      ...(input.modelOptions !== undefined ? { modelOptions: input.modelOptions } : {}),
      ...(holdUntil !== undefined ? { holdUntil } : {}),
    });
    // Null means the pump claimed the task between our read and write.
    if (!updated) {
      throw new BadRequestException('Only queued tasks can be updated');
    }
    // A re-arm may have pushed the earliest hold out; refresh the wake timer.
    if (holdUntil !== undefined) this.armHoldTimer();
    return updated;
  }

  /** Skip the rest of a held task's countdown and let the pump claim it now. */
  startNow(id: string): TaskDto {
    this.requireTask(id);
    const cleared = this.tasks.clearHold(id);
    if (!cleared) {
      throw new BadRequestException('Only held tasks can be started now');
    }
    void this.pump();
    return cleared;
  }

  delete(id: string): void {
    this.requireTask(id);
    if (!this.tasks.delete(id)) {
      throw new BadRequestException('Only finished tasks can be deleted');
    }
  }

  private requireTask(id: string): TaskDto {
    const task = this.tasks.findById(id);
    if (!task) throw new NotFoundException('Task not found');
    return task;
  }

  private concurrency(): number {
    const raw = this.settings?.resolve('NUNCIO_TASK_CONCURRENCY');
    const parsed = Number(raw);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : 1;
  }

  /** Launch grace window in ms: configurable, parsed leniently, clamped. */
  private countdownMs(): number {
    const raw = this.settings?.resolve('NUNCIO_MULTITASK_COUNTDOWN_SECONDS');
    const parsed = Number.parseInt(raw ?? '', 10);
    const seconds = Number.isNaN(parsed) ? DEFAULT_HOLD_SECONDS : clampHoldSeconds(parsed);
    return seconds * 1000;
  }

  onModuleDestroy(): void {
    this.destroyed = true;
    if (this.holdTimer) {
      clearTimeout(this.holdTimer);
      this.holdTimer = null;
    }
  }

  /**
   * FIFO pump. The claim→spawn body is fully synchronous, so concurrent pump
   * calls cannot over-claim past the cap in a single-threaded runtime. Held
   * tasks are skipped by claimNextQueued; a single wake timer re-runs the pump
   * when the earliest hold expires.
   */
  private pump(): void {
    if (this.destroyed) return;
    while (this.tasks.countRunning() < this.concurrency()) {
      const task = this.tasks.claimNextQueued();
      if (!task) break;
      void this.execute(task).finally(() => this.pump());
    }
    this.armHoldTimer();
  }

  /**
   * Keep exactly one timer aimed at the next hold expiry (replacing any prior).
   * Only holds strictly in the future get a timer: an already-expired hold is
   * claimable now, so the pump that runs when capacity frees (execute().finally
   * → pump) will claim it. Arming for an expired hold at full concurrency would
   * spin a setTimeout(0)→pump→setTimeout(0) busy-loop until a slot opens.
   */
  private armHoldTimer(): void {
    if (this.holdTimer) {
      clearTimeout(this.holdTimer);
      this.holdTimer = null;
    }
    if (this.destroyed) return;
    const earliest = this.tasks.earliestHold();
    if (earliest == null) return;
    const delay = earliest - Date.now();
    if (delay <= 0) return;
    this.holdTimer = setTimeout(() => this.pump(), delay);
  }

  private async execute(task: TaskDto): Promise<void> {
    try {
      const session = await this.sessions.create({
        prompt: task.prompt,
        ...(task.provider ? { provider: task.provider } : {}),
        ...(task.model ? { model: task.model } : {}),
        ...(task.modelOptions ? { modelOptions: task.modelOptions } : {}),
        ...(task.projectPath ? { projectPath: task.projectPath } : {}),
        ...(task.baseBranch ? { baseBranch: task.baseBranch } : {}),
        ...(task.useWorktree ? { useWorktree: true } : {}),
        ...(task.workspace ? { workspace: task.workspace } : {}),
      });
      this.tasks.attachSession(task.id, session.id);
      await this.sessions.awaitRun(session.id);
      // Wait for the verify-feedback loop (if any) to settle — a task's outcome
      // must reflect the loop's terminal verify (green / needs-attention), not the
      // first red result the initial run produced.
      await this.sessions.awaitVerifySettled(session.id);

      const final = this.sessions.get(session.id);
      const verify = this.lastVerifyResult(session.id);
      const needsAttention = this.needsAttention(session.id);
      this.tasks.finish(task.id, final?.status === 'IDLE' ? 'DONE' : 'FAILED', {
        sessionStatus: final?.status ?? 'UNKNOWN',
        ...(verify ? { verify } : {}),
        ...(needsAttention ? { needsAttention } : {}),
      });
      this.notifyFinished(task.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.tasks.finish(task.id, 'FAILED', { error: message });
      this.notifyFinished(task.id);
    }
  }

  private lastVerifyResult(sessionId: string): Record<string, unknown> | null {
    const tail = this.events.listTail(sessionId, PENDING_SCAN_TAIL);
    for (let i = tail.length - 1; i >= 0; i -= 1) {
      const event = tail[i];
      if (event?.type === 'verify_result') {
        return event.payload as Record<string, unknown>;
      }
    }
    return null;
  }

  /** The verify-feedback needs-attention payload if the loop gave up, else null. */
  private needsAttention(sessionId: string): Record<string, unknown> | null {
    const tail = this.events.listTail(sessionId, PENDING_SCAN_TAIL);
    for (let i = tail.length - 1; i >= 0; i -= 1) {
      const event = tail[i];
      if (event?.type === 'verify_needs_attention') {
        return event.payload as Record<string, unknown>;
      }
      if (event?.type === 'verify_result' && (event.payload as { ok?: boolean }).ok === true) {
        return null; // a later green verify cleared the needs-attention state
      }
    }
    return null;
  }
}
