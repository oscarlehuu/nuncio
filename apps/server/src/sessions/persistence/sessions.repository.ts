import { Injectable } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import { DatabaseService } from '../../db/database.service';
import { parseModelOptionsJson, stringifyModelOptions } from '../../models/model-options.types';
import { assertTransition } from '../domain/sessions.fsm';
import type { CreateSessionDto, SessionDto, SessionRow, SessionStatus } from '../domain/sessions.types';

function toDto(row: SessionRow): SessionDto {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    provider: row.provider,
    model: row.model,
    modelOptions: parseModelOptionsJson(row.model_options),
    workspace: row.workspace ?? null,
    prompt: row.prompt,
    preview: row.preview,
    projectPath: row.project_path,
    baseBranch: row.base_branch,
    worktreePath: row.worktree_path,
    branch: row.branch,
    cursorBackend: row.cursor_backend === 'cli' ? 'cli' : row.cursor_backend === 'sdk' ? 'sdk' : null,
    cursorChatId: row.cursor_chat_id ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function titleFromPrompt(prompt: string): string {
  const line = prompt.trim().split('\n')[0] ?? 'Untitled session';
  return line.length > 80 ? `${line.slice(0, 77)}...` : line;
}

@Injectable()
export class SessionsRepository {
  constructor(private readonly database: DatabaseService) {}

  list(includeArchived = false): SessionDto[] {
    const sql = includeArchived
      ? 'SELECT * FROM sessions ORDER BY updated_at DESC'
      : "SELECT * FROM sessions WHERE status != 'ARCHIVED' ORDER BY updated_at DESC";
    const rows = this.database.db.prepare<SessionRow, []>(sql).all();
    return rows.map(toDto);
  }

  findById(id: string): SessionDto | null {
    const row = this.database.db
      .prepare<SessionRow, [string]>('SELECT * FROM sessions WHERE id = ?')
      .get(id);
    return row ? toDto(row) : null;
  }

  findByCursorChatId(chatId: string, backend: 'cli' | 'sdk' = 'cli'): SessionDto | null {
    const row = this.database.db
      .prepare<SessionRow, [string, string]>(
        'SELECT * FROM sessions WHERE cursor_chat_id = ? AND cursor_backend = ? LIMIT 1',
      )
      .get(chatId, backend);
    return row ? toDto(row) : null;
  }

  create(input: CreateSessionDto): SessionDto {
    const now = Date.now();
    const id = input.id ?? uuidv4().slice(0, 8);
    const row: SessionRow = {
      id,
      title: titleFromPrompt(input.prompt),
      status: 'CREATED',
      provider: input.provider ?? 'pi',
      model: input.model ?? null,
      model_options: stringifyModelOptions(input.modelOptions),
      workspace: input.workspace?.trim() || null,
      prompt: input.prompt,
      preview: null,
      project_path: input.projectPath ?? null,
      base_branch: input.baseBranch ?? null,
      worktree_path: input.worktreePath ?? null,
      branch: input.branch ?? null,
      cursor_backend: input.cursorBackend ?? null,
      cursor_chat_id: input.cursorChatId ?? null,
      created_at: now,
      updated_at: now,
    };
    this.insertRow(row);
    return toDto(row);
  }

  createHandoff(input: {
    id?: string;
    title: string;
    workspace: string;
    cursorChatId: string;
    prompt: string;
    model?: string | null;
  }): SessionDto {
    const now = Date.now();
    const id = input.id ?? uuidv4().slice(0, 8);
    const row: SessionRow = {
      id,
      title: input.title,
      status: 'IDLE',
      provider: 'cursor',
      model: input.model ?? null,
      model_options: null,
      workspace: input.workspace.trim(),
      prompt: input.prompt,
      preview: null,
      project_path: null,
      base_branch: null,
      worktree_path: null,
      branch: null,
      cursor_backend: 'cli',
      cursor_chat_id: input.cursorChatId,
      created_at: now,
      updated_at: now,
    };
    this.insertRow(row);
    return toDto(row);
  }

  updateStatus(id: string, status: SessionStatus): SessionDto {
    const current = this.database.db
      .prepare<{ status: SessionStatus }, [string]>('SELECT status FROM sessions WHERE id = ?')
      .get(id);
    if (!current) throw new Error(`Session ${id} not found`);
    assertTransition(current.status, status);
    const now = Date.now();
    this.database.db
      .prepare('UPDATE sessions SET status = ?, updated_at = ? WHERE id = ?')
      .run(status, now, id);
    return this.findById(id)!;
  }

  touchPreview(id: string, preview: string): void {
    const now = Date.now();
    this.database.db
      .prepare('UPDATE sessions SET preview = ?, updated_at = ? WHERE id = ?')
      .run(preview.slice(0, 200), now, id);
  }

  delete(id: string): void {
    const deleteEvents = this.database.db.prepare('DELETE FROM events WHERE session_id = ?');
    const deleteSession = this.database.db.prepare('DELETE FROM sessions WHERE id = ?');
    const tx = this.database.db.transaction(() => {
      deleteEvents.run(id);
      deleteSession.run(id);
    });
    tx();
  }

  private insertRow(row: SessionRow): void {
    this.database.db
      .prepare(
        `INSERT INTO sessions (
          id, title, status, provider, model, model_options, workspace, prompt, preview,
          project_path, base_branch, worktree_path, branch,
          cursor_backend, cursor_chat_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.title,
        row.status,
        row.provider,
        row.model,
        row.model_options,
        row.workspace,
        row.prompt,
        row.preview,
        row.project_path,
        row.base_branch,
        row.worktree_path,
        row.branch,
        row.cursor_backend,
        row.cursor_chat_id,
        row.created_at,
        row.updated_at,
      );
  }
}
