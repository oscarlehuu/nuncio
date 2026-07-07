import { BadRequestException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { DatabaseService } from '../db/database.service';
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
    // Those tasks died with the daemon, but their parents still deserve a
    // FAILED digest so the delegation loop is closed after a restart.
    const interrupted = this.tasks.failInterrupted('daemon_restart');
    for (const failed of interrupted) {
      void this.emitTaskDigest(failed, failed.sessionId);
    }
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
    const task = this.requireTask(id);
    // A cancelled task is QUEUED and never ran, so it has no child session and
    // needs no async snapshot — build the digest synchronously so the cancel and
    // the parent-log append commit as one atomic unit.
    const built =
      task.parentSessionId && this.sessions.get(task.parentSessionId)
        ? { parentSessionId: task.parentSessionId, payload: buildOutcomeDigest({ ...task, status: 'CANCELLED' }, null, [], null) }
        : null;

    // Flush the parent buffer before the transaction (see finishWithDigest).
    if (built) this.sessions.flushParentBuffer(built.parentSessionId);

    const result = this.database.transaction<{ row: TaskDto | null; event: SessionEvent | null }>(() => {
      const row = this.tasks.cancel(id);
      if (!row || !built) return { row, event: null };
      const event = this.sessions.persistOrchestrationEvent(built.parentSessionId, 'task_completed', built.payload);
      return { row, event };
    });
    if (!result.row) {
      throw new BadRequestException('Only queued tasks can be cancelled');
    }
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

      const final = this.sessions.get(session.id);
      const verify = this.lastVerifyResult(session.id);
      status = final?.status === 'IDLE' ? 'DONE' : 'FAILED';
      outcome = { sessionStatus: final?.status ?? 'UNKNOWN', ...(verify ? { verify } : {}) };
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
      await this.finishWithDigest(task, status, childSessionId, outcome);
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
  ): Promise<void> {
    const built = await this.buildTaskDigest(task, status, childSessionId);
    if (!built) {
      this.tasks.finish(task.id, status, outcome);
      return;
    }

    // Flush the parent's buffered deltas BEFORE the transaction: the flush
    // appends+emits its own delta independently, so a later rollback of the
    // finish+digest transaction can never erase an already-broadcast delta.
    this.sessions.flushParentBuffer(built.parentSessionId);

    const persisted = this.database.transaction<SessionEvent | null>(() => {
      this.tasks.finish(task.id, status, outcome);
      return this.sessions.persistOrchestrationEvent(built.parentSessionId, 'task_completed', built.payload);
    });
    // Fan out to live subscribers only after the commit — never inside the txn.
    if (persisted) this.sessions.emitPersistedEvent(built.parentSessionId, persisted);
    // Optionally wake the parent (post-commit, best-effort).
    await this.maybeNotifyParent(task, built.parentSessionId, built.payload);
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

      const message = renderOutcomeDigest(payload);
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
}
