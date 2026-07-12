import { Injectable } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import { DatabaseService } from '../../db/database.service';
import type {
  ApplyCrewEventInput, CrewProfileSnapshot, CrewRunDto, CrewRunEventData, CrewRunProjection,
  CrewRunSummaryDto,
} from '../domain/crew.types';
import { CrewNotFoundError, CrewRevisionConflictError } from '../domain/crew-errors';
import { createInitialCrewRunProjection, reduceCrewRun } from '../domain/crew-run.reducer';
import { CrewEventsRepository } from './crew-events.repository';

interface RunRow {
  id: string; task_id: string; prior_run_id: string | null; phase: CrewRunDto['phase'];
  status: CrewRunDto['status']; outcome: CrewRunDto['outcome']; blocked_reason: CrewRunDto['blockedReason'];
  profile_snapshot_json: string; context_json: string; context_revision: number; revision: number;
  project_path: string; base_branch: string | null; base_head: string | null;
  worktree_path: string | null; branch: string | null;
  workspace_head: string | null; verify_retries_used: number; review_retries_used: number;
  verify_extra_rounds: number; review_extra_rounds: number; created_at: number; updated_at: number;
}

interface RunSummaryRow {
  id: string; task_id: string; objective: string; phase: CrewRunSummaryDto['phase'];
  status: CrewRunSummaryDto['status']; outcome: CrewRunSummaryDto['outcome'];
  blocked_reason: CrewRunSummaryDto['blockedReason']; revision: number;
  workspace_head: string | null; created_at: number; updated_at: number;
}

function toDto(row: RunRow): CrewRunDto {
  return {
    id: row.id, taskId: row.task_id, priorRunId: row.prior_run_id, phase: row.phase,
    status: row.status, outcome: row.outcome, blockedReason: row.blocked_reason,
    profileSnapshot: JSON.parse(row.profile_snapshot_json) as CrewProfileSnapshot,
    context: JSON.parse(row.context_json) as Record<string, unknown>,
    contextRevision: row.context_revision, revision: row.revision, projectPath: row.project_path,
    baseBranch: row.base_branch, baseHead: row.base_head, worktreePath: row.worktree_path, branch: row.branch,
    workspaceHead: row.workspace_head, verifyRetriesUsed: row.verify_retries_used,
    reviewRetriesUsed: row.review_retries_used, verifyExtraRounds: row.verify_extra_rounds,
    reviewExtraRounds: row.review_extra_rounds, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

@Injectable()
export class CrewRunsRepository {
  private readonly changeListeners = new Set<(
    run: CrewRunDto,
    event: CrewRunEventData,
  ) => void>();

  constructor(
    private readonly database: DatabaseService,
    private readonly events: CrewEventsRepository,
  ) {}
  onChanged(listener: (run: CrewRunDto, event: CrewRunEventData) => void): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }
  create(input: {
    taskId: string; priorRunId?: string | null; profileSnapshot: CrewProfileSnapshot;
    projectPath: string; baseBranch?: string | null; baseHead?: string | null; context?: Record<string, unknown>;
  }): CrewRunDto {
    return this.database.transaction(() => {
      const now = Date.now();
      const projection = reduceCrewRun(
        createInitialCrewRunProjection(), { type: 'run_created' }, input.profileSnapshot.policy,
      );
      const id = uuidv4();
      this.database.db.prepare(
        `INSERT INTO crew_runs
         (id, task_id, prior_run_id, phase, status, outcome, blocked_reason, profile_snapshot_json,
          context_json, context_revision, revision, project_path, base_branch, base_head, worktree_path, branch,
          workspace_head, verify_retries_used, review_retries_used, verify_extra_rounds,
          review_extra_rounds, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id, input.taskId, input.priorRunId ?? null, projection.phase, projection.status,
        projection.outcome, projection.blockedReason, JSON.stringify(input.profileSnapshot),
        JSON.stringify(input.context ?? {}),
        projection.contextRevision, projection.revision, input.projectPath, input.baseBranch ?? null,
        input.baseHead ?? null, null, null, projection.workspaceHead,
        projection.verifyRetriesUsed, projection.reviewRetriesUsed,
        projection.verifyExtraRounds, projection.reviewExtraRounds, now, now,
      );
      this.events.insert({
        runId: id, seq: 1, type: 'run_created', payload: {}, idempotencyKey: `run:${id}:created`,
        actor: 'nuncio', contextRevision: 0, workspaceHead: null, createdAt: now,
      });
      return this.require(id);
    });
  }
  findById(id: string): CrewRunDto | null {
    const row = this.database.db.prepare<RunRow, [string]>(
      'SELECT * FROM crew_runs WHERE id = ?',
    ).get(id);
    return row ? toDto(row) : null;
  }
  listByTask(taskId: string): CrewRunDto[] {
    return this.database.db.prepare<RunRow, [string]>(
      'SELECT * FROM crew_runs WHERE task_id = ? ORDER BY created_at ASC, rowid ASC',
    ).all(taskId).map(toDto);
  }
  list(filters: { status?: string; projectPath?: string } = {}): CrewRunDto[] {
    return this.database.db.prepare<RunRow, [string | null, string | null, string | null, string | null]>(
      `SELECT * FROM crew_runs
       WHERE (? IS NULL OR status = ?) AND (? IS NULL OR project_path = ?)
       ORDER BY created_at DESC, rowid DESC`,
    ).all(filters.status ?? null, filters.status ?? null, filters.projectPath ?? null, filters.projectPath ?? null).map(toDto);
  }
  listSummaries(filters: {
    status?: string; projectPath?: string; limit: number; offset: number;
  }): CrewRunSummaryDto[] {
    const rows = this.database.db.prepare<RunSummaryRow, [string | null, string | null, string | null, string | null, number, number]>(
      `WITH ranked AS (
         SELECT r.id, r.task_id, t.objective, r.phase, r.status, r.outcome, r.blocked_reason,
                r.revision, r.workspace_head, r.created_at, r.updated_at,
                ROW_NUMBER() OVER (
                  PARTITION BY r.task_id ORDER BY r.created_at DESC, r.rowid DESC
                ) AS task_rank
         FROM crew_runs r JOIN crew_tasks t ON t.id = r.task_id
         WHERE (? IS NULL OR r.project_path = ?)
       )
       SELECT id, task_id, objective, phase, status, outcome, blocked_reason, revision,
              workspace_head, created_at, updated_at
       FROM ranked
       WHERE task_rank = 1 AND (? IS NULL OR status = ?)
       ORDER BY updated_at DESC, created_at DESC, id ASC
       LIMIT ? OFFSET ?`,
    ).all(
      filters.projectPath ?? null, filters.projectPath ?? null,
      filters.status ?? null, filters.status ?? null, filters.limit, filters.offset,
    );
    return rows.map((row) => ({
      id: row.id, taskId: row.task_id, objective: row.objective, phase: row.phase,
      status: row.status, outcome: row.outcome, blockedReason: row.blocked_reason,
      revision: row.revision, workspaceHead: row.workspace_head,
      createdAt: row.created_at, updatedAt: row.updated_at,
    }));
  }
  applyEvent(runId: string, input: ApplyCrewEventInput): CrewRunDto {
    let applied = false;
    const run = this.database.transaction(() => {
      if (this.events.findByIdempotencyKey(runId, input.idempotencyKey)) return this.require(runId);
      const current = this.require(runId);
      if (current.revision !== input.expectedRevision) {
        throw new CrewRevisionConflictError(runId, input.expectedRevision, current);
      }
      const next = reduceCrewRun(current, input.event, current.profileSnapshot.policy);
      const nextContext = input.contextPatch
        ? { ...current.context, ...structuredClone(input.contextPatch) }
        : current.context;
      const { type, ...payload } = input.event;
      this.events.insert({
        runId, seq: next.revision, type, payload, idempotencyKey: input.idempotencyKey,
        actor: input.actor, contextRevision: next.contextRevision,
        workspaceHead: next.workspaceHead, createdAt: Date.now(),
      });
      const result = this.database.db.prepare(
        `UPDATE crew_runs SET phase = ?, status = ?, outcome = ?, blocked_reason = ?,
         context_json = ?, context_revision = ?, revision = ?, workspace_head = ?, verify_retries_used = ?,
         review_retries_used = ?, verify_extra_rounds = ?, review_extra_rounds = ?,
         worktree_path = COALESCE(?, worktree_path), branch = COALESCE(?, branch),
         base_branch = COALESCE(?, base_branch), base_head = COALESCE(?, base_head), updated_at = ?
         WHERE id = ? AND revision = ?`,
      ).run(
        next.phase, next.status, next.outcome, next.blockedReason, JSON.stringify(nextContext),
        next.contextRevision, next.revision,
        next.workspaceHead, next.verifyRetriesUsed, next.reviewRetriesUsed, next.verifyExtraRounds,
        next.reviewExtraRounds, input.workspace?.worktreePath ?? null, input.workspace?.branch ?? null,
        input.workspace?.baseBranch ?? null, input.workspace?.baseHead ?? null,
        Date.now(), runId, current.revision,
      );
      if (result.changes !== 1) throw new CrewRevisionConflictError(runId, input.expectedRevision, this.require(runId));
      applied = true;
      return this.require(runId);
    });
    if (applied) this.notifyChanged(run, input.event);
    return run;
  }
  replay(runId: string): CrewRunProjection {
    const run = this.require(runId);
    return this.events.listAll(runId).reduce((state, stored) => {
      const event = { type: stored.type, ...stored.payload } as CrewRunEventData;
      const next = reduceCrewRun(state, event, run.profileSnapshot.policy);
      if (next.revision !== stored.seq) throw new Error(`Crew event gap at ${stored.seq}`);
      return next;
    }, createInitialCrewRunProjection());
  }
  private require(id: string): CrewRunDto {
    const run = this.findById(id);
    if (!run) throw new CrewNotFoundError('CrewRun', id);
    return run;
  }
  private notifyChanged(run: CrewRunDto, event: CrewRunEventData): void {
    for (const listener of this.changeListeners) {
      try { listener(run, event); } catch { /* observers cannot roll back committed Crew state */ }
    }
  }
}
