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
      .prepare<EventRow, [string, number]>(
        'SELECT * FROM events WHERE session_id = ? AND seq > ? ORDER BY seq ASC',
      )
      .all(sessionId, since);
    return rows.map(parseEvent);
  }

  append(sessionId: string, type: string, payload: unknown): SessionEvent {
    const now = Date.now();
    const next = this.database.db
      .prepare<{ seq: number }, [string]>('SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM events WHERE session_id = ?')
      .get(sessionId);
    const seq = next?.seq ?? 1;
    const row = {
      session_id: sessionId,
      seq,
      type,
      payload: JSON.stringify(payload),
      created_at: now,
    };
    this.database.db
      .prepare(
        `INSERT INTO events (session_id, seq, type, payload, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(row.session_id, row.seq, row.type, row.payload, row.created_at);
    return { seq, type, payload, createdAt: now };
  }

  appendBatch(
    sessionId: string,
    items: Array<{ type: string; payload: unknown }>,
  ): SessionEvent[] {
    if (items.length === 0) return [];
    const results: SessionEvent[] = [];
    const tx = this.database.db.transaction(() => {
      for (const item of items) {
        results.push(this.append(sessionId, item.type, item.payload));
      }
    });
    tx();
    return results;
  }

  count(sessionId: string): number {
    const row = this.database.db
      .prepare<{ count: number }, [string]>('SELECT COUNT(*) AS count FROM events WHERE session_id = ?')
      .get(sessionId);
    return row?.count ?? 0;
  }
}
