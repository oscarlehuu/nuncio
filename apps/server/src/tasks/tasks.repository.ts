import { Injectable } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import { DatabaseService } from '../db/database.service';
import type { ModelOptionsMap } from '../models/model-options.types';
import {
  TERMINAL_TASK_STATUSES,
  type CreateTaskDto,
  type TaskDto,
  type TaskRow,
  type TaskStatus,
} from './tasks.types';

function parseJson<T>(value: string | null): T | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function toDto(row: TaskRow): TaskDto {
  return {
    id: row.id,
    prompt: row.prompt,
    status: row.status,
    provider: row.provider,
    model: row.model,
    modelOptions: parseJson<ModelOptionsMap>(row.model_options),
    projectPath: row.project_path,
    baseBranch: row.base_branch,
    useWorktree: row.use_worktree === 1,
    workspace: row.workspace,
    sessionId: row.session_id,
    outcome: parseJson<Record<string, unknown>>(row.outcome_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

@Injectable()
export class TasksRepository {
  constructor(private readonly database: DatabaseService) {}

  create(input: CreateTaskDto): TaskDto {
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
           base_branch, use_worktree, workspace, session_id, outcome_json, created_at, updated_at,
           started_at, finished_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id, row.prompt, row.status, row.provider, row.model, row.model_options,
        row.project_path, row.base_branch, row.use_worktree, row.workspace, row.session_id,
        row.outcome_json, row.created_at, row.updated_at, row.started_at, row.finished_at,
      );
    return toDto(row);
  }

  list(): TaskDto[] {
    const rows = this.database.db
      .prepare<TaskRow, []>('SELECT * FROM tasks ORDER BY created_at DESC, rowid DESC')
      .all();
    return rows.map(toDto);
  }

  findById(id: string): TaskDto | null {
    const row = this.database.db
      .prepare<TaskRow, [string]>('SELECT * FROM tasks WHERE id = ?')
      .get(id);
    return row ? toDto(row) : null;
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
    return row ? toDto(row) : null;
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
        `UPDATE tasks SET status = ?, outcome_json = ?, finished_at = ?, updated_at = ?
         WHERE id = ? AND status = 'RUNNING'`,
      )
      .run(status, JSON.stringify(outcome), now, now, id);
    return this.findById(id);
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
    return row ? toDto(row) : null;
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
        `UPDATE tasks SET status = 'FAILED', outcome_json = ?, finished_at = ?, updated_at = ?
         WHERE status = 'RUNNING'
         RETURNING *`,
      )
      .all(JSON.stringify({ reason }), now, now);
    return rows.map(toDto);
  }

  delete(id: string): boolean {
    const task = this.findById(id);
    if (!task || !TERMINAL_TASK_STATUSES.includes(task.status)) return false;
    this.database.db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
    return true;
  }
}

export type { TaskStatus };
