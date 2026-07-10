import {
  BadRequestException,
  Injectable,
  NotFoundException,
  Optional,
  type OnModuleDestroy,
} from '@nestjs/common';
import { RetainedEventFlushError } from '../agents/agents.base-provider';
import { DatabaseService } from '../db/database.service';
import type { ModelOptionsMap } from '../models/model-options.types';
import { assembleSubagentBrief } from '../orchestration/handoff-brief.assembler';
import { buildOutcomeDigest } from '../orchestration/outcome-digest.builder';
import { renderOutcomeDigest } from '../orchestration/outcome-digest.renderer';
import type { HandoffBrief } from '../orchestration/handoff-brief.types';
import { buildWorkspaceSnapshot } from '../orchestration/workspace-snapshot';
import type { TaskCompletedPayload } from '../sessions/domain/events.types';
import { deriveHasPendingInput } from '../sessions/domain/derive-pending-input';
import type { SessionDto, SessionEvent } from '../sessions/domain/sessions.types';
import { EventsRepository } from '../sessions/persistence/events.repository';
import { resolveVerifyCommand } from '../sessions/session-verifier';
import { SessionsService } from '../sessions/sessions.service';
import { PromptProfileService } from '../prompts/prompt-profile.service';
import { SettingsService } from '../settings/settings.service';
import { buildSubagentTaskInput } from './multitask-defaults';
import { TasksRepository } from './tasks.repository';
import {
  NOTIFY_POLICIES,
  TERMINAL_TASK_STATUSES,
  type CreateTaskDto,
  type NotifyPolicy,
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
const RETAINED_PARENT_FLUSH_RETRY_MS = 100;

function clampHoldSeconds(seconds: number): number {
  return Math.min(MAX_HOLD_SECONDS, Math.max(MIN_HOLD_SECONDS, seconds));
}

const GOAL_MAX_CHARS = 200;

/**
 * Specialize the shared parent brief for one child by swapping in that child's
 * own prompt as the goal. Returns undefined when there is no assembled base
 * (an explicit DTO brief is in play), leaving the caller's override untouched.
 */

/** Collapse a task status into the digest's terminal vocabulary. */
function digestStatus(status: TaskDto['status']): 'DONE' | 'FAILED' | 'CANCELLED' {
  if (status === 'DONE') return 'DONE';
  if (status === 'CANCELLED') return 'CANCELLED';
  return 'FAILED';
}

/** Marks a steer_message as an auto-steer wake so the rate cap can count it. */
const DIGEST_STEER_ORIGIN = 'task-digest';
/** A parent this deep in a delegation chain never auto-steers (anti ping-pong). */
const STEER_DEPTH_CAP = 2;
/** Max auto-steers per parent session within the rolling window. */
const STEER_RATE_CAP = 5;
const STEER_RATE_WINDOW_MS = 60 * 60 * 1000;

function briefForPrompt(base: HandoffBrief | null, prompt: string): HandoffBrief | undefined {
  if (!base) return undefined;
  return { ...base, goal: prompt.slice(0, GOAL_MAX_CHARS) };
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
  private readonly bootInterruptedTaskIds = new Set<string>();

  constructor(
    private readonly tasks: TasksRepository,
    private readonly sessions: SessionsService,
    private readonly events: EventsRepository,
    private readonly database: DatabaseService,
    @Optional() private readonly settings?: SettingsService,
    @Optional() private readonly profiles?: PromptProfileService,
  ) {
    // A RUNNING row at boot means the runner died mid-task; its session was
    // already reconciled by the sessions sweep. Queued work simply resumes.
    // Those tasks died with the daemon, but their parents still deserve a
    // FAILED digest so the delegation loop is closed after a restart.
    const interrupted = this.tasks.failInterrupted('daemon_restart');
    for (const failed of interrupted) {
      this.bootInterruptedTaskIds.add(failed.id);
      void this.emitTaskDigest(failed, failed.sessionId);
    }
    void this.pump();
  }

  /** Register a task-settlement listener (e.g. the loop primitive). */
  onTaskFinished(handler: (task: TaskDto) => void): () => void {
    this.finishHandlers.add(handler);
    this.replayBootInterruptedTasks(handler);
    return () => this.finishHandlers.delete(handler);
  }

  /** One task by id, or null (used by consumers correlating settlement). */
  findById(id: string): TaskDto | null {
    return this.tasks.findById(id);
  }

  private notifyFinished(task: TaskDto): void {
    if (this.finishHandlers.size === 0) return;
    for (const handler of this.finishHandlers) {
      try {
        handler(task);
      } catch {
        // A listener must never break the runner.
      }
    }
  }

  private replayBootInterruptedTasks(handler: (task: TaskDto) => void): void {
    for (const taskId of this.bootInterruptedTaskIds) {
      const task = this.tasks.findById(taskId);
      if (!task || !TERMINAL_TASK_STATUSES.includes(task.status)) continue;
      try {
        handler(task);
      } catch {
        // A listener must never break registration.
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

  async startMultitask(input: StartMultitaskDto): Promise<StartMultitaskResultDto> {
    const parentSessionId = input.parentSessionId?.trim();
    if (!parentSessionId) throw new BadRequestException('parentSessionId is required');
    const parent = this.sessions.get(parentSessionId);
    if (!parent) throw new NotFoundException('Parent session not found');

    const prompts = input.prompts
      ?.map((prompt) => prompt.trim())
      .filter(Boolean);
    if (!prompts?.length) throw new BadRequestException('at least one prompt is required');

    const explicitBrief = Boolean(input.contextBrief);
    const base = explicitBrief ? null : await this.assembleParentBrief(parent);
    const tasks = prompts.map((prompt) =>
      this.enqueue({
        ...buildSubagentTaskInput(input, parent, prompt, this.settings, briefForPrompt(base, prompt)),
        ...(!explicitBrief ? { holdUntil: Date.now() + this.countdownMs() } : {}),
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
  async startMultitaskFromQueue(parentSessionId: string): Promise<StartMultitaskResultDto> {
    const trimmed = parentSessionId?.trim();
    if (!trimmed) throw new BadRequestException('parentSessionId is required');
    const parent = this.sessions.get(trimmed);
    if (!parent) throw new NotFoundException('Parent session not found');

    // Claim (lease) the queued rows synchronously, BEFORE any await. A claim
    // hides them from the normal settle-drain, so a parent run that settles
    // during the async work below cannot deliver the same messages again.
    const claimed = this.sessions.claimSteerQueueForMultitask(trimmed);
    if (claimed.length === 0) {
      throw new BadRequestException('No queued messages to multitask');
    }
    const claimedIds = claimed.map((steer) => steer.id);

    // If assembly fails, the claim must not strand the messages — release them
    // AND re-schedule a settle-drain, since the parent may have already settled
    // and drained empty while the rows were claimed (nothing else would).
    let base: HandoffBrief;
    try {
      base = await this.assembleParentBrief(parent);
    } catch (error) {
      this.releaseAndRescheduleDrain(trimmed, claimedIds);
      throw error;
    }

    // Insert every child task and delete the claimed rows as ONE atomic unit,
    // via create() directly (not enqueue()) so the pump never interleaves
    // mid-batch. A failure rolls back every insert while the claimed rows
    // survive; we then release the claim so the messages re-enter normal flow.
    const prompts = claimed.map((steer) => steer.message);
    let tasks: TaskDto[];
    try {
      tasks = this.database.transaction(() => {
        const created = prompts.map((prompt) =>
          this.tasks.create(
            {
              ...buildSubagentTaskInput(
                { parentSessionId: trimmed, prompts },
                parent,
                prompt,
                this.settings,
                briefForPrompt(base, prompt),
              ),
              holdUntil: Date.now() + this.countdownMs(),
            },
          ),
        );
        this.sessions.steerQueueRepository.deleteByIds(claimedIds);
        return created;
      });
    } catch (error) {
      this.releaseAndRescheduleDrain(trimmed, claimedIds);
      throw error;
    }

    // Commit succeeded: kick the pump once for the whole batch and tell live
    // clients to drop the queued placeholders.
    void this.pump();
    this.sessions.emitSteerQueueCleared(trimmed);

    return { parentSessionId: trimmed, tasks };
  }

  /**
   * A fan-out that claimed rows but aborted must both release the claim and
   * kick a settle-drain: the parent may have already settled and drained empty
   * (the claim hid the rows), so without this the freed messages would sit
   * undelivered until an unrelated trigger.
   */
  private releaseAndRescheduleDrain(sessionId: string, claimedIds: number[]): void {
    this.sessions.releaseClaimedSteers(claimedIds);
    this.sessions.scheduleSteerDrain(sessionId);
  }

  /**
   * Assemble the shared portion of the handoff brief once per parent: workspace
   * snapshot, harvested files, verify command, parent objective. The per-child
   * goal is swapped in later. Best-effort — a snapshot failure yields a
   * still-useful brief with a null workspace.
   */
  private async assembleParentBrief(parent: SessionDto): Promise<HandoffBrief> {
    const cwd = parent.worktreePath ?? parent.workspace ?? parent.projectPath ?? null;
    const workspace = cwd
      ? await buildWorkspaceSnapshot(cwd, parent.baseBranch ?? parent.branch)
      : null;
    const verify = cwd
      ? resolveVerifyCommand(cwd, this.settings?.resolve('NUNCIO_VERIFY_COMMAND'))
      : null;
    return assembleSubagentBrief({
      parent,
      subagentPrompt: parent.prompt, // placeholder goal; replaced per prompt
      parentTailEvents: this.events.listTail(parent.id, PENDING_SCAN_TAIL),
      workspace,
      verifyCommand: verify?.display ?? null,
    });
  }

  async cancel(id: string): Promise<TaskDto> {
    const task = this.requireTask(id);
    const reserved = this.tasks.updateWhileQueued(id, { holdUntil: Number.MAX_SAFE_INTEGER });
    if (!reserved) throw new BadRequestException('Only queued tasks can be cancelled');
    const previousHold = task.holdUntil ?? null;
    // A cancelled task is QUEUED and never ran, so it has no child session and
    // needs no async snapshot — build the digest synchronously so the cancel and
    // the parent-log append commit as one atomic unit.
    const built =
      task.parentSessionId && this.sessions.get(task.parentSessionId)
        ? { parentSessionId: task.parentSessionId, payload: buildOutcomeDigest({ ...task, status: 'CANCELLED' }, null, [], null) }
        : null;

    const commit = () => this.database.transaction<{ row: TaskDto | null; event: SessionEvent | null }>(() => {
        const row = this.tasks.cancel(id);
        if (!row || !built) return { row, event: null };
        const event = this.sessions.persistOrchestrationEvent(built.parentSessionId, 'task_completed', built.payload);
        return { row, event };
      });
    // Keep the final synchronous flush adjacent to the digest transaction. An
    // already-queued provider microtask can buffer another delta while the
    // retained-tail retry await yields.
    let result: { row: TaskDto | null; event: SessionEvent | null };
    try {
      result = built
        ? await this.afterParentBufferFlush(built.parentSessionId, commit)
        : commit();
    } catch (error) {
      // The digest/cancel transaction did not commit. Release the cancellation
      // lease so normal task execution can resume instead of stranding the row.
      this.tasks.updateWhileQueued(id, { holdUntil: previousHold });
      this.pump();
      throw error;
    }
    if (!result.row) {
      throw new BadRequestException('Only queued tasks can be cancelled');
    }
    // Cancel is a terminal settlement path — notify finish-hook consumers (a loop
    // folds the cancelled run to failed) exactly as DONE/FAILED do. Without this,
    // a cancelled loop task would leave its run pending forever, bricking the loop.
    this.notifyFinished(result.row);
    if (result.event && built) {
      this.sessions.emitPersistedEvent(built.parentSessionId, result.event);
      void this.maybeNotifyParent(result.row, built.parentSessionId, built.payload);
    }
    return result.row;
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
      ...(task.contextBrief ? { contextBrief: task.contextBrief } : {}),
      ...(task.notifyPolicy ? { notifyPolicy: task.notifyPolicy } : {}),
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
    let childSessionId: string | null = null;
    // Determine the terminal outcome from the run; a run failure sets FAILED.
    let status: 'DONE' | 'FAILED' = 'FAILED';
    let outcome: Record<string, unknown> = {};
    try {
      // The brief travels as a field; SessionsService.create composes it (and
      // project facts) into the first prompt at the single choke point, so
      // task.prompt stays pure in the DB (retry/clone semantics unaffected).
      const session = await this.sessions.create({
        prompt: task.prompt,
        ...(task.contextBrief ? { contextBrief: task.contextBrief } : {}),
        ...(task.provider ? { provider: task.provider } : {}),
        ...(task.model ? { model: task.model } : {}),
        ...(task.modelOptions ? { modelOptions: task.modelOptions } : {}),
        ...(task.projectPath ? { projectPath: task.projectPath } : {}),
        ...(task.baseBranch ? { baseBranch: task.baseBranch } : {}),
        ...(task.useWorktree ? { useWorktree: true } : {}),
        ...(task.workspace ? { workspace: task.workspace } : {}),
        ...(task.parentSessionId ? { parentSessionId: task.parentSessionId } : {}),
        originTaskId: task.id,
      });
      childSessionId = session.id;
      this.tasks.attachSession(task.id, session.id);
      await this.sessions.awaitRun(session.id);
      // Wait for the verify-feedback loop (if any) to settle — a task's outcome
      // must reflect the loop's terminal verify (green / needs-attention), not the
      // first red result the initial run produced.
      await this.sessions.awaitVerifySettled(session.id);

      const final = this.sessions.get(session.id);
      const verify = this.lastVerifyResult(session.id);
      const needsAttention = this.needsAttention(session.id);
      status = final?.status === 'IDLE' ? 'DONE' : 'FAILED';
      outcome = {
        sessionStatus: final?.status ?? 'UNKNOWN',
        ...(verify ? { verify } : {}),
        ...(needsAttention ? { needsAttention } : {}),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      status = 'FAILED';
      outcome = { error: message };
    }

    // Finalize OUTSIDE the run try/catch: finish + digest commit atomically. A
    // transaction failure here must NOT re-enter the run's failure path (that
    // would double-finish); the transaction rolled back, so the task stays
    // RUNNING and boot reconciliation will fail it — consistent with a crash
    // before the commit. Log and leave it; do not re-finish.
    try {
      const finished = await this.finishWithDigest(task, status, childSessionId, outcome);
      if (finished) this.notifyFinished(finished);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[tasks] finish+digest transaction failed for ${task.id}; left for boot recovery: ${message}`);
    }
  }

  /**
   * Mark a task terminal AND append its parent digest as one atomic unit, so a
   * crash can never leave a finished task without its digest (or vice versa).
   * The digest payload (including the async workspace snapshot) is built while
   * the task is still RUNNING; a build failure degrades to finishing without a
   * digest (annotate-don't-block). The parent-log fanout happens only after the
   * transaction commits.
   */
  private async finishWithDigest(
    task: TaskDto,
    status: 'DONE' | 'FAILED',
    childSessionId: string | null,
    outcome: Record<string, unknown>,
  ): Promise<TaskDto | null> {
    const built = await this.buildTaskDigest(task, status, childSessionId);
    if (!built) {
      return this.tasks.finish(task.id, status, outcome);
    }

    // The final flush and transaction run in one synchronous turn so a parent
    // delta cannot overtake its task digest after the retry await yields.
    const result = await this.afterParentBufferFlush(built.parentSessionId, () =>
      this.database.transaction<{ row: TaskDto | null; event: SessionEvent | null }>(() => {
        const row = this.tasks.finish(task.id, status, outcome);
        const event = this.sessions.persistOrchestrationEvent(built.parentSessionId, 'task_completed', built.payload);
        return { row, event };
      }),
    );
    // Fan out to live subscribers only after the commit — never inside the txn.
    if (result.event) this.sessions.emitPersistedEvent(built.parentSessionId, result.event);
    // Optionally wake the parent (post-commit, best-effort).
    if (result.row) await this.maybeNotifyParent(result.row, built.parentSessionId, built.payload);
    return result.row;
  }

  /**
   * A provider retains a delta whose append failed and retries it in place.
   * Task settlement must wait for that earlier transcript position before it
   * atomically commits the terminal row and digest; otherwise the task can stay
   * RUNNING until a daemon restart after a recoverable database failure.
   */
  private async flushParentBufferWithRetry(parentSessionId: string): Promise<void> {
    while (!this.destroyed) {
      try {
        this.sessions.flushParentBuffer(parentSessionId);
        return;
      } catch (error) {
        if (!(error instanceof RetainedEventFlushError)) throw error;
        await new Promise((resolve) => setTimeout(resolve, RETAINED_PARENT_FLUSH_RETRY_MS));
      }
    }
    throw new Error('Tasks service stopped before the retained parent tail could be flushed');
  }

  private async afterParentBufferFlush<T>(parentSessionId: string, operation: () => T): Promise<T> {
    while (!this.destroyed) {
      await this.flushParentBufferWithRetry(parentSessionId);
      try {
        // No await may appear between this final flush and operation().
        this.sessions.flushParentBuffer(parentSessionId);
      } catch (error) {
        if (error instanceof RetainedEventFlushError) continue;
        throw error;
      }
      return operation();
    }
    throw new Error('Tasks service stopped before the parent operation could commit');
  }

  /** Effective notify policy: per-task override wins over the setting/default. */
  private effectiveNotifyPolicy(task: TaskDto): NotifyPolicy {
    if (task.notifyPolicy) return task.notifyPolicy;
    const raw = this.settings?.resolve('NUNCIO_DELEGATE_NOTIFY');
    return NOTIFY_POLICIES.includes(raw as NotifyPolicy) ? (raw as NotifyPolicy) : 'event-only';
  }

  /**
   * When the effective policy is `steer`, wake the parent with the rendered
   * digest so it can continue autonomously. Best-effort and non-fatal — a
   * failure here never destabilizes the just-finished task. Hard guards
   * (depth, rate) and non-IDLE/RUNNING states fall back to event-only and log a
   * status-level note explaining why the parent was not woken.
   */
  private async maybeNotifyParent(
    task: TaskDto,
    parentSessionId: string,
    payload: TaskCompletedPayload,
  ): Promise<void> {
    try {
      if (this.effectiveNotifyPolicy(task) !== 'steer') return;
      const parent = this.sessions.get(parentSessionId);
      if (!parent) return;

      // Guard: suppress when the FINISHING (child) session's own chain is ≥ 2
      // deep (anti ping-pong). The child's chain length = the parent's ancestor
      // depth + 1 (the parent itself). Net: only a depth-1 child may wake its
      // root parent.
      const childChainDepth = this.sessions.lineage(parentSessionId).ancestors.length + 1;
      if (childChainDepth >= STEER_DEPTH_CAP) {
        this.noteSteerSuppressed(
          parentSessionId,
          `delegation chain depth ${childChainDepth} ≥ ${STEER_DEPTH_CAP}`,
        );
        return;
      }
      // Guard: rate-limit auto-steers per parent within the rolling window.
      if (this.recentDigestSteers(parentSessionId) >= STEER_RATE_CAP) {
        this.noteSteerSuppressed(
          parentSessionId,
          `auto-steer rate cap (${STEER_RATE_CAP}/hour) reached`,
        );
        return;
      }

      // D2: the parent engine's digest-wrapper shapes the message it receives.
      const digestWrapper = this.profiles?.resolve(parent.provider, parent.model).sections.digestWrapper;
      const message = renderOutcomeDigest(payload, digestWrapper ? { digestWrapper } : {});
      if (parent.status === 'IDLE' || parent.status === 'RUNNING') {
        // steer() delivers immediately when IDLE and enqueues (origin-tagged)
        // when RUNNING; either way the resulting steer_message carries origin.
        await this.sessions.steer(parentSessionId, message, undefined, undefined, DIGEST_STEER_ORIGIN);
      } else {
        // PAUSED / ERROR / etc. → event-only fallback.
        this.noteSteerSuppressed(parentSessionId, `parent status ${parent.status}`);
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.warn(`[tasks] auto-steer notify failed for parent ${parentSessionId}: ${reason}`);
    }
  }

  /**
   * Count auto-steer wakes attributable to this parent within the window:
   * DELIVERED (origin-tagged steer_message events, exact SQL count so a chatty
   * transcript can't hide them) PLUS PENDING (queued wakes not yet drained).
   * Counting the queue at enqueue time closes the RUNNING-parent bypass without
   * needing a drain-time recheck.
   */
  private recentDigestSteers(parentSessionId: string): number {
    const cutoff = Date.now() - STEER_RATE_WINDOW_MS;
    const delivered = this.events.countRecentByTypeWithOriginTag(
      parentSessionId,
      'steer_message',
      DIGEST_STEER_ORIGIN,
      cutoff,
    );
    const pending = this.sessions.steerQueueRepository.countByOrigin(parentSessionId, DIGEST_STEER_ORIGIN);
    return delivered + pending;
  }

  /** Append a status-level note explaining why an auto-steer was suppressed. */
  private noteSteerSuppressed(parentSessionId: string, reason: string): void {
    this.sessions.appendOrchestrationEvent(parentSessionId, 'status', {
      note: `Auto-steer suppressed: ${reason}. Digest delivered as event only.`,
    });
  }

  /**
   * Build the digest payload for a terminal task (best-effort, non-fatal). The
   * async workspace snapshot is taken here, BEFORE the task is marked terminal,
   * so the finish+append transaction stays synchronous. Returns null when there
   * is no parent to notify, the parent vanished, or the build throws.
   */
  private async buildTaskDigest(
    task: TaskDto,
    status: 'DONE' | 'FAILED' | 'CANCELLED',
    childSessionId: string | null,
  ): Promise<{ parentSessionId: string; payload: TaskCompletedPayload } | null> {
    if (!task.parentSessionId) return null;
    if (!this.sessions.get(task.parentSessionId)) return null;
    try {
      const child = childSessionId ? this.sessions.get(childSessionId) : null;
      const cwd = child
        ? child.worktreePath ?? child.workspace ?? child.projectPath ?? null
        : null;
      const workspace = cwd
        ? await buildWorkspaceSnapshot(cwd, child?.baseBranch ?? child?.branch)
        : null;
      const events = childSessionId ? this.events.listTail(childSessionId, PENDING_SCAN_TAIL) : [];
      // The DB row is still RUNNING at build time; digest reflects the pending
      // terminal status.
      const payload = buildOutcomeDigest({ ...task, status }, childSessionId, events, workspace);
      return { parentSessionId: task.parentSessionId, payload };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[tasks] failed to build task_completed digest for ${task.id}: ${message}`);
      return null;
    }
  }

  /**
   * Emit a digest for an already-terminal task (cancel / boot-recovery paths,
   * where the task row is not transitioning RUNNING→terminal in this call).
   * Best-effort; append failure never destabilizes the caller.
   */
  private async emitTaskDigest(task: TaskDto, childSessionId: string | null): Promise<void> {
    const built = await this.buildTaskDigest(task, digestStatus(task.status), childSessionId);
    if (!built) return;
    try {
      this.sessions.appendOrchestrationEvent(built.parentSessionId, 'task_completed', built.payload);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[tasks] failed to append task_completed digest for ${task.id}: ${message}`);
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
