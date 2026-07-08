import { Injectable } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import { DatabaseService } from '../db/database.service';
import { taskRowToDto } from './task-row-mapper';
import {
  TERMINAL_TASK_STATUSES,
  type CreateTaskDto,
  type TaskDto,
  type TaskRow,
  type TaskStatus,
} from './tasks.types';

@Injectable()
export class TasksRepository {
  constructor(private readonly database: DatabaseService) {}

  create(input: CreateTaskDto): TaskDto {
    return this.createMany([input])[0]!;
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
      session_id: null,
      outcome_json: null,
      created_at: now,
      updated_at: now,
      started_at: null,
      finished_at: null,
    };
    this.database.db
      .prepare(
        `INSERT INTO tasks (id, prompt, status, provider, model, model_options, project_path,
           base_branch, use_worktree, workspace, parent_session_id, role, cleanup_policy,
           review_state, session_id, outcome_json, created_at, updated_at, started_at, finished_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id, row.prompt, row.status, row.provider, row.model, row.model_options,
        row.project_path, row.base_branch, row.use_worktree, row.workspace, row.parent_session_id,
        row.role, row.cleanup_policy, row.review_state, row.session_id, row.outcome_json,
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

  /** Atomically claim the oldest QUEUED task, marking it RUNNING. */
  claimNextQueued(): TaskDto | null {
    const now = Date.now();
    const row = this.database.db
      .prepare<TaskRow, [number, number]>(
        `UPDATE tasks SET status = 'RUNNING', started_at = ?, updated_at = ?
         WHERE id = (
           SELECT id FROM tasks WHERE status = 'QUEUED' ORDER BY created_at ASC, rowid ASC LIMIT 1
         )
         RETURNING *`,
      )
      .get(now, now);
    return row ? taskRowToDto(row) : null;
  }

  attachSession(id: string, sessionId: string): void {
    this.database.db
      .prepare('UPDATE tasks SET session_id = ?, updated_at = ? WHERE id = ?')
      .run(sessionId, Date.now(), id);
  }

  finish(id: string, status: 'DONE' | 'FAILED', outcome: Record<string, unknown>): TaskDto | null {
    const now = Date.now();
    this.database.db
      .prepare(
        `UPDATE tasks
         SET status = ?,
             outcome_json = ?,
             finished_at = ?,
             updated_at = ?,
             review_state = CASE
               WHEN role = 'subagent' AND ? IN ('DONE', 'FAILED') THEN 'awaiting_review'
               ELSE review_state
             END
         WHERE id = ? AND status = 'RUNNING'`,
      )
      .run(status, JSON.stringify(outcome), now, now, status, id);
    return this.findById(id);
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
    return row ? taskRowToDto(row) : null;
  }

  countRunning(): number {
    const row = this.database.db
      .prepare<{ count: number }, []>("SELECT COUNT(*) AS count FROM tasks WHERE status = 'RUNNING'")
      .get();
    return row?.count ?? 0;
  }

  /** Boot reconciliation: a RUNNING row after restart means the runner died mid-task. */
  failInterrupted(reason: string): TaskDto[] {
    const now = Date.now();
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
    return rows.map(taskRowToDto);
  }

  delete(id: string): boolean {
    const task = this.findById(id);
    if (!task || !TERMINAL_TASK_STATUSES.includes(task.status)) return false;
    this.database.db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
    return true;
  }
}

export type { TaskStatus };
