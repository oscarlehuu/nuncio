import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../db/database.service';
import type { EventRow, SessionEvent } from '../domain/sessions.types';

function parseEvent(row: EventRow): SessionEvent {
  return {
    seq: row.seq,
    type: row.type,
    payload: JSON.parse(row.payload),
    createdAt: row.created_at,
  };
}

@Injectable()
export class EventsRepository {
  constructor(private readonly database: DatabaseService) {}

  list(sessionId: string, since = 0): SessionEvent[] {
    const rows = this.database.db
      .prepare(
        'SELECT * FROM events WHERE session_id = ? AND seq > ? ORDER BY seq ASC',
      )
      .all(sessionId, since) as EventRow[];
    return rows.map(parseEvent);
  }

  append(sessionId: string, type: string, payload: unknown): SessionEvent {
    const now = Date.now();
    const next = this.database.db
      .prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM events WHERE session_id = ?')
      .get(sessionId) as { seq: number };
    const row = {
      session_id: sessionId,
      seq: next.seq,
      type,
      payload: JSON.stringify(payload),
      created_at: now,
    };
    this.database.db
      .prepare(
        `INSERT INTO events (session_id, seq, type, payload, created_at)
         VALUES (@session_id, @seq, @type, @payload, @created_at)`,
      )
      .run(row);
    return { seq: row.seq, type, payload, createdAt: now };
  }
}
