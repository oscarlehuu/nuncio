import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../db/database.service';
import { truncatePayload } from '../domain/events.types';
import { notifySessionEventHooks } from '../domain/session-event-hooks';
import type { EventRow, SessionEvent } from '../domain/sessions.types';

/**
 * Hard ceiling per stored event payload. Providers already truncate tool
 * output at 4 KB; this guards every other append path so one oversized
 * payload can never bloat a session's log permanently.
 */
export const MAX_EVENT_PAYLOAD_BYTES = 128 * 1024;

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

  list(sessionId: string, since = 0, limit?: number): SessionEvent[] {
    const rows =
      limit !== undefined
        ? this.database.db
            .prepare<EventRow, [string, number, number]>(
              'SELECT * FROM events WHERE session_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?',
            )
            .all(sessionId, since, limit)
        : this.database.db
            .prepare<EventRow, [string, number]>(
              'SELECT * FROM events WHERE session_id = ? AND seq > ? ORDER BY seq ASC',
            )
            .all(sessionId, since);
    return rows.map(parseEvent);
  }

  /**
   * Events with `seq > since`, ascending, bounded by `limit` — the compact
   * replay path (renderEventsSince) uses this to pull a session slice without
   * loading the whole log.
   */
  listSince(sessionId: string, since: number, limit: number): SessionEvent[] {
    return this.list(sessionId, since, limit);
  }

  /** The last `limit` events, in ascending seq order. */
  listTail(sessionId: string, limit: number): SessionEvent[] {
    const rows = this.database.db
      .prepare<EventRow, [string, number]>(
        'SELECT * FROM events WHERE session_id = ? ORDER BY seq DESC LIMIT ?',
      )
      .all(sessionId, limit);
    return rows.map(parseEvent).reverse();
  }

  /** The `limit` events immediately preceding `before`, in ascending seq order. */
  listBefore(sessionId: string, before: number, limit: number): SessionEvent[] {
    const rows = this.database.db
      .prepare<EventRow, [string, number, number]>(
        'SELECT * FROM events WHERE session_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?',
      )
      .all(sessionId, before, limit);
    return rows.map(parseEvent).reverse();
  }

  /**
   * Count events of a given type since `sinceMs` whose serialized payload
   * carries `"origin":"<originTag>"`. The LIKE match is exact for OUR own writes
   * (we control the serialized shape: `JSON.stringify` emits `"origin":"..."`
   * with no spaces), which is all this is used for (the auto-steer rate cap). A
   * bounded SQL count, so it never misses a hit behind a chatty tail window.
   */
  countRecentByTypeWithOriginTag(
    sessionId: string,
    type: string,
    originTag: string,
    sinceMs: number,
  ): number {
    const row = this.database.db
      .prepare<{ total: number }, [string, string, number, string]>(
        `SELECT COUNT(*) AS total FROM events
         WHERE session_id = ? AND type = ? AND created_at >= ? AND payload LIKE ?`,
      )
      .get(sessionId, type, sinceMs, `%"origin":"${originTag}"%`);
    return row?.total ?? 0;
  }

  append(sessionId: string, type: string, payload: unknown): SessionEvent {
    const now = Date.now();
    const stored = truncatePayload(payload, MAX_EVENT_PAYLOAD_BYTES).value;
    // A turn that outlived shutdown must not write to a closed handle; return a
    // synthetic (unpersisted, seq 0) event so callers/emitters don't blow up.
    if (this.database.closed) {
      return { seq: 0, type, payload: stored, createdAt: now };
    }
    const next = this.database.db
      .prepare<{ seq: number }, [string]>('SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM events WHERE session_id = ?')
      .get(sessionId);
    const seq = next?.seq ?? 1;
    const row = {
      session_id: sessionId,
      seq,
      type,
      payload: JSON.stringify(stored),
      created_at: now,
    };
    this.database.db
      .prepare(
        `INSERT INTO events (session_id, seq, type, payload, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(row.session_id, row.seq, row.type, row.payload, row.created_at);
    const event: SessionEvent = { seq, type, payload: stored, createdAt: now };
    notifySessionEventHooks(sessionId, event);
    return event;
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

  /** Epoch-ms of the most recent event for a session, or null if it has none. */
  latestEventAt(sessionId: string): number | null {
    if (this.database.closed) return null;
    const row = this.database.db
      .prepare<{ at: number | null }, [string]>(
        'SELECT MAX(created_at) AS at FROM events WHERE session_id = ?',
      )
      .get(sessionId);
    return row?.at ?? null;
  }
}
