import { Injectable } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import { DatabaseService } from '../db/database.service';
import type {
  ContextFactDto,
  ContextFactRow,
  FactProvenance,
  UpsertContextFactInput,
} from './context-facts.types';

function toDto(row: ContextFactRow): ContextFactDto {
  return {
    id: row.id,
    projectPath: row.project_path,
    key: row.key,
    value: row.value,
    provenance: row.provenance === 'agent' ? 'agent' : 'founder',
    sourceSessionId: row.source_session_id ?? null,
    pinned: row.pinned === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

@Injectable()
export class ContextFactsRepository {
  constructor(private readonly database: DatabaseService) {}

  /**
   * Insert a fact, or update the existing one for (project_path, key) in place —
   * preserving its id and created_at. A single statement, so it is atomic.
   */
  upsert(input: UpsertContextFactInput): ContextFactDto {
    const now = Date.now();
    const existing = this.getByKey(input.projectPath, input.key);
    const id = existing?.id ?? uuidv4().slice(0, 8);
    const createdAt = existing?.createdAt ?? now;
    const provenance: FactProvenance = input.provenance === 'agent' ? 'agent' : 'founder';
    this.database.db
      .prepare(
        `INSERT INTO context_facts
           (id, project_path, key, value, provenance, source_session_id, pinned, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(project_path, key) DO UPDATE SET
           value = excluded.value,
           provenance = excluded.provenance,
           source_session_id = excluded.source_session_id,
           pinned = excluded.pinned,
           updated_at = excluded.updated_at`,
      )
      .run(
        id,
        input.projectPath,
        input.key,
        input.value,
        provenance,
        input.sourceSessionId ?? null,
        input.pinned ? 1 : 0,
        createdAt,
        now,
      );
    return this.getByKey(input.projectPath, input.key)!;
  }

  list(projectPath: string): ContextFactDto[] {
    const rows = this.database.db
      .prepare<ContextFactRow, [string]>(
        'SELECT * FROM context_facts WHERE project_path = ? ORDER BY updated_at DESC, key ASC',
      )
      .all(projectPath);
    return rows.map(toDto);
  }

  /** Pinned facts first, then updated_at desc; bounded by `limit`. */
  listPinnedFirst(projectPath: string, limit: number): ContextFactDto[] {
    const rows = this.database.db
      .prepare<ContextFactRow, [string, number]>(
        `SELECT * FROM context_facts WHERE project_path = ?
         ORDER BY pinned DESC, updated_at DESC, key ASC LIMIT ?`,
      )
      .all(projectPath, limit);
    return rows.map(toDto);
  }

  get(id: string): ContextFactDto | null {
    const row = this.database.db
      .prepare<ContextFactRow, [string]>('SELECT * FROM context_facts WHERE id = ?')
      .get(id);
    return row ? toDto(row) : null;
  }

  getByKey(projectPath: string, key: string): ContextFactDto | null {
    const row = this.database.db
      .prepare<ContextFactRow, [string, string]>(
        'SELECT * FROM context_facts WHERE project_path = ? AND key = ?',
      )
      .get(projectPath, key);
    return row ? toDto(row) : null;
  }

  delete(id: string): boolean {
    const result = this.database.db.prepare('DELETE FROM context_facts WHERE id = ?').run(id);
    return result.changes > 0;
  }

  count(projectPath: string): number {
    const row = this.database.db
      .prepare<{ total: number }, [string]>('SELECT COUNT(*) AS total FROM context_facts WHERE project_path = ?')
      .get(projectPath);
    return row?.total ?? 0;
  }
}
