import { Injectable } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import { DatabaseService } from '../../db/database.service';
import { assertTransition } from '../domain/sessions.fsm';
import type { CreateSessionDto, SessionDto, SessionRow, SessionStatus } from '../domain/sessions.types';

function toDto(row: SessionRow): SessionDto {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    provider: row.provider,
    model: row.model,
    prompt: row.prompt,
    preview: row.preview,
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
    const rows = this.database.db.prepare(sql).all() as SessionRow[];
    return rows.map(toDto);
  }

  findById(id: string): SessionDto | null {
    const row = this.database.db
      .prepare('SELECT * FROM sessions WHERE id = ?')
      .get(id) as SessionRow | undefined;
    return row ? toDto(row) : null;
  }

  create(input: CreateSessionDto): SessionDto {
    const now = Date.now();
    const id = uuidv4().slice(0, 8);
    const row: SessionRow = {
      id,
      title: titleFromPrompt(input.prompt),
      status: 'CREATED',
      provider: input.provider ?? 'pi',
      model: input.model ?? null,
      prompt: input.prompt,
      preview: null,
      created_at: now,
      updated_at: now,
    };
    this.database.db
      .prepare(
        `INSERT INTO sessions (id, title, status, provider, model, prompt, preview, created_at, updated_at)
         VALUES (@id, @title, @status, @provider, @model, @prompt, @preview, @created_at, @updated_at)`,
      )
      .run(row);
    return toDto(row);
  }

  updateStatus(id: string, status: SessionStatus): SessionDto {
    const current = this.database.db
      .prepare('SELECT status FROM sessions WHERE id = ?')
      .get(id) as { status: SessionStatus } | undefined;
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
}
