import { Injectable } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import type { ModelOptionsMap } from '../models/model-options.types';
import { DatabaseService } from '../db/database.service';
import { stringifyAgentRuntimePolicy } from '../agents/agent-runtime-policy';
import { taskRowToDto } from './task-row-mapper';
import {
  TERMINAL_TASK_STATUSES,
  type CreateTaskDto,
  type TaskDto,
  type TaskRow,
  type TaskStatus,
} from './tasks.types';

export interface TaskReconciliation {
  taskId: string;
  digestPending: boolean;
  settlementPending: boolean;
  task: TaskDto | null;
}

interface TaskReconciliationRow {
  task_id: string;
  digest_pending: number;
  settlement_pending: number;
}

@Injectable()
export class TasksRepository {
  private readonly cancellationReservations = new Set<string>();
  constructor(private readonly database: DatabaseService) {}

  create(input: CreateTaskDto): TaskDto {
    return this.createMany([input])[0]!;
  }

  /** Insert one row inside a transaction already owned by the caller. */
  createInCurrentTransaction(input: CreateTaskDto): TaskDto {
    return taskRowToDto(this.insert(input));
  }

  createMany(inputs: CreateTaskDto[]): TaskDto[] {
    const rows: TaskRow[] = [];
    const tx = this.database.db.transaction(() => {
      for (const input of inputs) rows.push(this.insert(input));
    });
    tx();
    return rows.map(taskRowToDto);
  }

  private insert(input: CreateTaskDto): TaskRow {
    const now = Date.now();
    const row: TaskRow = {
      id: uuidv4().slice(0, 8),
      prompt: input.prompt,
      status: 'QUEUED',
      provider: input.provider ?? null,
      model: input.model ?? null,
      model_options: input.modelOptions ? JSON.stringify(input.modelOptions) : null,
      project_path: input.projectPath ?? null,
      base_branch: input.baseBranch ?? null,
      use_worktree: input.useWorktree === true ? 1 : 0,
      workspace: input.workspace ?? null,
      parent_session_id: input.parentSessionId ?? null,
      role: input.role ?? 'standalone',
      cleanup_policy: input.cleanupPolicy ?? null,
      review_state: null,
      session_id: input.sessionId ?? null,
      outcome_json: null,
      hold_until: input.holdUntil ?? null,
      context_json: input.contextBrief ? JSON.stringify(input.contextBrief) : null,
      notify_policy: input.notifyPolicy ?? null,
      tag: input.tag ?? null,
      crew_run_id: input.crewRunId ?? null,
      crew_member_key: input.crewMemberKey ?? null,
      crew_phase: input.crewPhase ?? null,
      crew_attempt_key: input.crewAttemptKey ?? null,
      execution_kind: input.executionKind ?? 'session',
      runtime_policy_json: stringifyAgentRuntimePolicy(input.runtimePolicy),
      verify_owner: input.verifyOwner ?? 'session',
      schedule_dispatch_intent_id: this.database.currentScheduleDispatchIntentId,
      created_at: now,
      updated_at: now,
      started_at: null,
      finished_at: null,
    };
    this.database.db
      .prepare(
        `INSERT INTO tasks (id, prompt, status, provider, model, model_options, project_path,
           base_branch, use_worktree, workspace, parent_session_id, role, cleanup_policy,
           review_state, session_id, outcome_json, hold_until, context_json, notify_policy, tag,
           crew_run_id, crew_member_key, crew_phase, crew_attempt_key,
           execution_kind, runtime_policy_json, verify_owner, schedule_dispatch_intent_id,
           created_at, updated_at, started_at, finished_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id, row.prompt, row.status, row.provider, row.model, row.model_options,
        row.project_path, row.base_branch, row.use_worktree, row.workspace, row.parent_session_id,
        row.role, row.cleanup_policy, row.review_state, row.session_id, row.outcome_json,
        row.hold_until, row.context_json, row.notify_policy, row.tag,
        row.crew_run_id, row.crew_member_key, row.crew_phase, row.crew_attempt_key, row.execution_kind,
        row.runtime_policy_json, row.verify_owner, row.schedule_dispatch_intent_id,
        row.created_at, row.updated_at, row.started_at, row.finished_at,
      );
    return row;
  }

  list(): TaskDto[] {
    const rows = this.database.db
      .prepare<TaskRow, []>('SELECT * FROM tasks ORDER BY created_at DESC, rowid DESC')
      .all();
    return rows.map(taskRowToDto);
  }

  listByParentSession(parentSessionId: string): TaskDto[] {
    const rows = this.database.db
      .prepare<TaskRow, [string]>(
        `SELECT * FROM tasks
         WHERE parent_session_id = ?
         ORDER BY created_at DESC, rowid DESC`,
      )
      .all(parentSessionId);
    return rows.map(taskRowToDto);
  }

  findById(id: string): TaskDto | null {
    const row = this.database.db
      .prepare<TaskRow, [string]>('SELECT * FROM tasks WHERE id = ?')
      .get(id);
    return row ? taskRowToDto(row) : null;
  }

  findByApprovalCorrelation(correlationKey: string): TaskDto | null {
    const row = this.database.db.prepare<TaskRow, [string]>(
      `SELECT tasks.* FROM tasks
       INNER JOIN task_approval_correlations AS correlations
         ON correlations.task_id = tasks.id
       WHERE correlations.correlation_key = ?`,
    ).get(correlationKey);
    if (row) return taskRowToDto(row);
    this.database.db.prepare(
      `DELETE FROM task_approval_correlations
       WHERE correlation_key = ?
         AND NOT EXISTS (
           SELECT 1 FROM tasks WHERE tasks.id = task_approval_correlations.task_id
         )`,
    ).run(correlationKey);
    return null;
  }

  correlateApprovalTask(
    correlationKey: string,
    taskId: string,
    options: { activeOnly?: boolean } = {},
  ): TaskDto | null {
    const existing = this.findByApprovalCorrelation(correlationKey);
    if (existing) return existing;
    const task = this.findById(taskId);
    if (!task) return null;
    if (options.activeOnly && task.status !== 'QUEUED' && task.status !== 'RUNNING') return null;
    this.database.db.prepare(
      `INSERT INTO task_approval_correlations (correlation_key, task_id, created_at)
       VALUES (?, ?, ?)`,
    ).run(correlationKey, task.id, Date.now());
    return task;
  }

  createApprovalTaskInCurrentTransaction(
    input: CreateTaskDto,
    correlationKey: string,
  ): TaskDto {
    const existing = this.findByApprovalCorrelation(correlationKey);
    if (existing) return existing;
    const task = this.createInCurrentTransaction(input);
    this.database.db.prepare(
      `INSERT INTO task_approval_correlations (correlation_key, task_id, created_at)
       VALUES (?, ?, ?)`,
    ).run(correlationKey, task.id, Date.now());
    return task;
  }

  /** Atomically claim the oldest QUEUED task past its hold window, marking it RUNNING. */
  claimNextQueued(options: { includeCrewMembers?: boolean } = {}): TaskDto | null {
    const now = Date.now();
    const candidates = this.database.db
      .prepare<{ id: string }, [number, number]>(
        `SELECT id FROM tasks
         WHERE status = 'QUEUED'
           AND (? = 1 OR execution_kind != 'crew-member')
           AND (hold_until IS NULL OR hold_until <= ?)
         ORDER BY created_at ASC, rowid ASC`,
      )
      .all(options.includeCrewMembers === false ? 0 : 1, now);
    const candidate = candidates.find((row) => !this.cancellationReservations.has(row.id));
    if (!candidate) return null;
    const row = this.database.db
      .prepare<TaskRow, [number, number, string]>(
        `UPDATE tasks SET status = 'RUNNING', started_at = ?, updated_at = ?
         WHERE id = ? AND status = 'QUEUED'
         RETURNING *`,
      )
      .get(now, now, candidate.id);
    return row ? taskRowToDto(row) : null;
  }

  reserveCancellation(id: string): TaskDto | null {
    const task = this.findById(id);
    if (!task || task.status !== 'QUEUED') return null;
    this.cancellationReservations.add(id);
    return task;
  }

  releaseCancellation(id: string): void {
    this.cancellationReservations.delete(id);
  }

  attachSession(id: string, sessionId: string): void {
    this.database.db
      .prepare('UPDATE tasks SET session_id = ?, updated_at = ? WHERE id = ?')
      .run(sessionId, Date.now(), id);
  }

  finish(id: string, status: 'DONE' | 'FAILED', outcome: Record<string, unknown>): TaskDto | null {
    const now = Date.now();
    const row = this.database.db
      .prepare<TaskRow, [string, string, number, number, string, string]>(
        `UPDATE tasks
         SET status = ?,
             outcome_json = ?,
             finished_at = ?,
             updated_at = ?,
             review_state = CASE
               WHEN role = 'subagent' AND ? IN ('DONE', 'FAILED') THEN 'awaiting_review'
               ELSE review_state
             END
         WHERE id = ? AND status = 'RUNNING'
         RETURNING *`,
      )
      .get(status, JSON.stringify(outcome), now, now, status, id);
    return row ? taskRowToDto(row) : null;
  }

  markReviewed(id: string): TaskDto | null {
    const now = Date.now();
    const row = this.database.db
      .prepare<TaskRow, [number, string]>(
        `UPDATE tasks SET review_state = 'reviewed', updated_at = ?
         WHERE id = ?
           AND role = 'subagent'
           AND status IN ('DONE', 'FAILED')
           AND review_state = 'awaiting_review'
         RETURNING *`,
      )
      .get(now, id);
    return row ? taskRowToDto(row) : null;
  }

  /**
   * Patch a still-queued task's routing/hold. Only the provided fields are
   * written; the WHERE guard makes the update a no-op (null result) once the
   * pump has claimed the task, so the service can surface the race as a 400.
   */
  updateWhileQueued(
    id: string,
    patch: { provider?: string; model?: string; modelOptions?: ModelOptionsMap | null; holdUntil?: number | null },
  ): TaskDto | null {
    const sets: string[] = [];
    const values: Array<string | number | null> = [];
    if (patch.provider !== undefined) {
      sets.push('provider = ?');
      values.push(patch.provider);
    }
    if (patch.model !== undefined) {
      sets.push('model = ?');
      values.push(patch.model);
    }
    if (patch.modelOptions !== undefined) {
      sets.push('model_options = ?');
      values.push(patch.modelOptions ? JSON.stringify(patch.modelOptions) : null);
    }
    if (patch.holdUntil !== undefined) {
      sets.push('hold_until = ?');
      values.push(patch.holdUntil);
    }
    // updated_at is always bumped so an empty patch is still a valid UPDATE.
    sets.push('updated_at = ?');
    values.push(Date.now());

    const row = this.database.db
      .prepare<TaskRow, Array<string | number | null>>(
        `UPDATE tasks SET ${sets.join(', ')} WHERE id = ? AND status = 'QUEUED' RETURNING *`,
      )
      .get(...values, id);
    return row ? taskRowToDto(row) : null;
  }

  /** Drop the hold on a still-queued, still-held task so the pump can claim it now. */
  clearHold(id: string): TaskDto | null {
    const row = this.database.db
      .prepare<TaskRow, [number, string]>(
        `UPDATE tasks SET hold_until = NULL, updated_at = ?
         WHERE id = ? AND status = 'QUEUED' AND hold_until IS NOT NULL
         RETURNING *`,
      )
      .get(Date.now(), id);
    return row ? taskRowToDto(row) : null;
  }

  /** Earliest pending hold expiry across queued tasks, or null when none are held. */
  earliestHold(): number | null {
    const row = this.database.db
      .prepare<{ earliest: number | null }, []>(
        "SELECT MIN(hold_until) AS earliest FROM tasks WHERE status = 'QUEUED' AND hold_until IS NOT NULL",
      )
      .get();
    return row?.earliest ?? null;
  }

  /** Only queued work can be cancelled; running work belongs to its session. */
  cancel(id: string): TaskDto | null {
    const now = Date.now();
    const row = this.database.db
      .prepare<TaskRow, [number, number, string]>(
        `UPDATE tasks SET status = 'CANCELLED', finished_at = ?, updated_at = ?
         WHERE id = ? AND status = 'QUEUED'
         RETURNING *`,
      )
      .get(now, now, id);
    this.cancellationReservations.delete(id);
    return row ? taskRowToDto(row) : null;
  }

  /** Owner-only cancellation for hidden Crew attempts, including an active runner claim. */
  cancelCrewMember(id: string): TaskDto | null {
    const now = Date.now();
    const row = this.database.db
      .prepare<TaskRow, [number, number, string]>(
        `UPDATE tasks SET status = 'CANCELLED', finished_at = ?, updated_at = ?
         WHERE id = ?
           AND execution_kind = 'crew-member'
           AND status IN ('QUEUED', 'RUNNING')
         RETURNING *`,
      )
      .get(now, now, id);
    if (row) return taskRowToDto(row);
    const existing = this.findById(id);
    return existing?.executionKind === 'crew-member' && existing.status === 'CANCELLED'
      ? existing
      : null;
  }

  countRunning(): number {
    const row = this.database.db
      .prepare<{ count: number }, []>("SELECT COUNT(*) AS count FROM tasks WHERE status = 'RUNNING'")
      .get();
    return row?.count ?? 0;
  }

  /**
   * Boot reconciliation: terminalize every orphaned RUNNING task and enqueue its
   * digest/settlement replay in the same transaction. A daemon death after this
   * commit can lose neither the FAILED state nor the work needed to publish it.
   */
  failInterrupted(reason: string): TaskDto[] {
    const now = Date.now();
    return this.database.immediateTransaction(() => {
      const rows = this.database.db
        .prepare<TaskRow, [string, number, number]>(
          `UPDATE tasks
           SET status = 'FAILED',
               outcome_json = ?,
               finished_at = ?,
               updated_at = ?,
               review_state = CASE
                 WHEN role = 'subagent' THEN 'awaiting_review'
                 ELSE review_state
               END
           WHERE status = 'RUNNING'
           RETURNING *`,
        )
        .all(JSON.stringify({ reason }), now, now);
      const enqueue = this.database.db.prepare(
        `INSERT INTO task_reconciliation_outbox
           (task_id, digest_pending, settlement_pending, created_at, updated_at)
         VALUES (?, 1, 1, ?, ?)
         ON CONFLICT(task_id) DO NOTHING`,
      );
      for (const row of rows) enqueue.run(row.id, now, now);
      return rows.map(taskRowToDto);
    });
  }

  listPendingReconciliations(): TaskReconciliation[] {
    const rows = this.database.db
      .prepare<TaskReconciliationRow, []>(
        `SELECT task_id, digest_pending, settlement_pending
         FROM task_reconciliation_outbox
         WHERE digest_pending = 1 OR settlement_pending = 1
         ORDER BY created_at ASC, rowid ASC`,
      )
      .all();
    return rows.map((row) => ({
      taskId: row.task_id,
      digestPending: row.digest_pending === 1,
      settlementPending: row.settlement_pending === 1,
      task: this.findById(row.task_id),
    }));
  }

  markReconciliationDigestHandled(taskId: string): boolean {
    const claimed = this.database.db.prepare<{ task_id: string }, [number, string]>(
      `UPDATE task_reconciliation_outbox
       SET digest_pending = 0, updated_at = ?
       WHERE task_id = ? AND digest_pending = 1
       RETURNING task_id`,
    ).get(Date.now(), taskId);
    return Boolean(claimed);
  }

  markReconciliationSettlementHandled(taskId: string): boolean {
    return this.database.transaction(() => {
      const claimed = this.database.db.prepare<{ task_id: string }, [number, string]>(
        `UPDATE task_reconciliation_outbox
         SET settlement_pending = 0, updated_at = ?
         WHERE task_id = ? AND settlement_pending = 1
         RETURNING task_id`,
      ).get(Date.now(), taskId);
      if (!claimed) return false;
      this.database.db.prepare(
        `DELETE FROM task_reconciliation_outbox
         WHERE task_id = ? AND digest_pending = 0 AND settlement_pending = 0`,
      ).run(taskId);
      return true;
    });
  }

  deleteReconciliation(taskId: string): void {
    this.database.db.prepare(
      'DELETE FROM task_reconciliation_outbox WHERE task_id = ?',
    ).run(taskId);
  }

  delete(id: string): boolean {
    const task = this.findById(id);
    if (!task || !TERMINAL_TASK_STATUSES.includes(task.status)) return false;
    this.database.transaction(() => {
      this.database.db.prepare('DELETE FROM task_reconciliation_outbox WHERE task_id = ?').run(id);
      this.database.db.prepare('DELETE FROM task_approval_correlations WHERE task_id = ?').run(id);
      this.database.db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
    });
    return true;
  }
}

export type { TaskStatus };
