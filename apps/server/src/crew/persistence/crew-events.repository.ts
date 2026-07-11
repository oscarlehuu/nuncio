import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../db/database.service';
import type { CrewRunEventDto } from '../domain/crew.types';

@Injectable()
export class CrewEventsRepository {
  constructor(private readonly database: DatabaseService) {}
  list(runId: string, since = 0, limit = 200): CrewRunEventDto[] {
    const safeLimit = Math.max(1, Math.min(1000, Math.trunc(limit)));
    return this.database.db.prepare<EventRow, [string, number, number]>(
      `SELECT * FROM crew_events WHERE run_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?`,
    ).all(runId, since, safeLimit).map(toDto);
  }
  findByIdempotencyKey(runId: string, key: string): CrewRunEventDto | null {
    const row = this.database.db.prepare<EventRow, [string, string]>(
      'SELECT * FROM crew_events WHERE run_id = ? AND idempotency_key = ?',
    ).get(runId, key);
    return row ? toDto(row) : null;
  }
  listAll(runId: string): CrewRunEventDto[] {
    return this.database.db.prepare<EventRow, [string]>(
      'SELECT * FROM crew_events WHERE run_id = ? ORDER BY seq ASC',
    ).all(runId).map(toDto);
  }
  insert(event: CrewRunEventDto): void {
    this.database.db.prepare(
      `INSERT INTO crew_events
       (run_id, seq, type, payload_json, idempotency_key, actor, context_revision, workspace_head, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      event.runId, event.seq, event.type, JSON.stringify(event.payload), event.idempotencyKey,
      event.actor, event.contextRevision, event.workspaceHead, event.createdAt,
    );
  }
}

interface EventRow {
  run_id: string; seq: number; type: CrewRunEventDto['type']; payload_json: string;
  idempotency_key: string; actor: string; context_revision: number;
  workspace_head: string | null; created_at: number;
}
function toDto(row: EventRow): CrewRunEventDto {
  return {
    runId: row.run_id, seq: row.seq, type: row.type,
    payload: JSON.parse(row.payload_json) as Record<string, unknown>,
    idempotencyKey: row.idempotency_key, actor: row.actor,
    contextRevision: row.context_revision, workspaceHead: row.workspace_head, createdAt: row.created_at,
  };
}
