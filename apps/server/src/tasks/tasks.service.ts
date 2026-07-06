import { BadRequestException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { DatabaseService } from '../db/database.service';
import { assembleSubagentBrief } from '../orchestration/handoff-brief.assembler';
import { renderHandoffBrief } from '../orchestration/handoff-brief.renderer';
import type { HandoffBrief } from '../orchestration/handoff-brief.types';
import { buildWorkspaceSnapshot } from '../orchestration/workspace-snapshot';
import { deriveHasPendingInput } from '../sessions/domain/derive-pending-input';
import type { SessionDto } from '../sessions/domain/sessions.types';
import { EventsRepository } from '../sessions/persistence/events.repository';
import { resolveVerifyCommand } from '../sessions/session-verifier';
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

const GOAL_MAX_CHARS = 200;

/**
 * Specialize the shared parent brief for one child by swapping in that child's
 * own prompt as the goal. Returns undefined when there is no assembled base
 * (an explicit DTO brief is in play), leaving the caller's override untouched.
 */
function briefForPrompt(base: HandoffBrief | null, prompt: string): HandoffBrief | undefined {
  if (!base) return undefined;
  return { ...base, goal: prompt.slice(0, GOAL_MAX_CHARS) };
}

@Injectable()
export class TasksService {
  constructor(
    private readonly tasks: TasksRepository,
    private readonly sessions: SessionsService,
    private readonly events: EventsRepository,
    private readonly database: DatabaseService,
    @Optional() private readonly settings?: SettingsService,
  ) {
    // A RUNNING row at boot means the runner died mid-task; its session was
    // already reconciled by the sessions sweep. Queued work simply resumes.
    this.tasks.failInterrupted('daemon_restart');
    void this.pump();
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
    const prompt = input.prompt?.trim();
    if (!prompt) throw new BadRequestException('prompt is required');
    const task = this.tasks.create({ ...input, prompt });
    void this.pump();
    return task;
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

    const base = input.contextBrief ? null : await this.assembleParentBrief(parent);
    const tasks = prompts.map((prompt) =>
      this.enqueue(
        buildSubagentTaskInput(input, parent, prompt, this.settings, briefForPrompt(base, prompt)),
      ),
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
            buildSubagentTaskInput(
              { parentSessionId: trimmed, prompts },
              parent,
              prompt,
              this.settings,
              briefForPrompt(base, prompt),
            ),
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

  cancel(id: string): TaskDto {
    this.requireTask(id);
    const cancelled = this.tasks.cancel(id);
    if (!cancelled) {
      throw new BadRequestException('Only queued tasks can be cancelled');
    }
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
      ...(task.contextBrief ? { contextBrief: task.contextBrief } : {}),
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

  /**
   * FIFO pump. The claim→spawn body is fully synchronous, so concurrent pump
   * calls cannot over-claim past the cap in a single-threaded runtime.
   */
  private pump(): void {
    while (this.tasks.countRunning() < this.concurrency()) {
      const task = this.tasks.claimNextQueued();
      if (!task) return;
      void this.execute(task).finally(() => this.pump());
    }
  }

  private async execute(task: TaskDto): Promise<void> {
    try {
      // The brief is prepended to the session prompt only; task.prompt stays
      // pure in the DB so retry/clone semantics are unaffected.
      const prompt = task.contextBrief
        ? `${renderHandoffBrief(task.contextBrief)}\n\n---\n\n${task.prompt}`
        : task.prompt;
      const session = await this.sessions.create({
        prompt,
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

      const final = this.sessions.get(session.id);
      const verify = this.lastVerifyResult(session.id);
      this.tasks.finish(task.id, final?.status === 'IDLE' ? 'DONE' : 'FAILED', {
        sessionStatus: final?.status ?? 'UNKNOWN',
        ...(verify ? { verify } : {}),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.tasks.finish(task.id, 'FAILED', { error: message });
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
}
