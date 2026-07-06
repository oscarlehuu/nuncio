import { Injectable } from '@nestjs/common';
import type { AgentAttachment } from '../../agents/agents.types';
import { DatabaseService } from '../../db/database.service';

interface SteerQueueRow {
  id: number;
  session_id: string;
  message: string;
  attachments_json: string | null;
  created_at: number;
}

export interface QueuedSteer {
  message: string;
  attachments?: AgentAttachment[];
}

function parseAttachments(raw: string | null): AgentAttachment[] | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as AgentAttachment[];
    return Array.isArray(parsed) && parsed.length > 0 ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Durable FIFO of steers accepted while a session was RUNNING (survives restarts). */
@Injectable()
export class SteerQueueRepository {
  constructor(private readonly database: DatabaseService) {}

  enqueue(sessionId: string, message: string, attachments?: AgentAttachment[]): void {
    this.database.db
      .prepare(
        `INSERT INTO steer_queue (session_id, message, attachments_json, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(
        sessionId,
        message,
        attachments && attachments.length > 0 ? JSON.stringify(attachments) : null,
        Date.now(),
      );
  }

  /** Pop the oldest queued steer for the session; null when the queue is empty. */
  dequeue(sessionId: string): QueuedSteer | null {
    const row = this.database.db
      .prepare<SteerQueueRow, [string]>(
        'SELECT * FROM steer_queue WHERE session_id = ? ORDER BY id ASC LIMIT 1',
      )
      .get(sessionId);
    if (!row) return null;
    this.database.db.prepare('DELETE FROM steer_queue WHERE id = ?').run(row.id);
    const attachments = parseAttachments(row.attachments_json);
    return { message: row.message, ...(attachments ? { attachments } : {}) };
  }

  /**
   * Read the queued steers (with their row ids) in FIFO order WITHOUT deleting
   * them. The caller commits durable follow-on work first, then removes exactly
   * these ids via {@link deleteByIds} — so a crash mid-fan-out never loses a
   * steer, and a steer that arrives after this read survives untouched.
   */
  peekAll(sessionId: string): Array<QueuedSteer & { id: number }> {
    const rows = this.database.db
      .prepare<SteerQueueRow, [string]>(
        'SELECT * FROM steer_queue WHERE session_id = ? ORDER BY id ASC',
      )
      .all(sessionId);
    return rows.map((row) => {
      const attachments = parseAttachments(row.attachments_json);
      return { id: row.id, message: row.message, ...(attachments ? { attachments } : {}) };
    });
  }

  /** Delete exactly the given row ids (no-op on an empty list). */
  deleteByIds(ids: number[]): void {
    if (ids.length === 0) return;
    const placeholders = ids.map(() => '?').join(', ');
    this.database.db.prepare(`DELETE FROM steer_queue WHERE id IN (${placeholders})`).run(...ids);
  }

  /** Pop every queued steer for the session in FIFO order, emptying the queue. */
  drainAll(sessionId: string): QueuedSteer[] {
    const rows = this.database.db
      .prepare<SteerQueueRow, [string]>(
        'SELECT * FROM steer_queue WHERE session_id = ? ORDER BY id ASC',
      )
      .all(sessionId);
    if (rows.length === 0) return [];
    this.database.db.prepare('DELETE FROM steer_queue WHERE session_id = ?').run(sessionId);
    return rows.map((row) => {
      const attachments = parseAttachments(row.attachments_json);
      return { message: row.message, ...(attachments ? { attachments } : {}) };
    });
  }

  count(sessionId: string): number {
    const row = this.database.db
      .prepare<{ total: number }, [string]>(
        'SELECT COUNT(*) AS total FROM steer_queue WHERE session_id = ?',
      )
      .get(sessionId);
    return row?.total ?? 0;
  }

  /** Sessions that still have queued steers — the boot restore work-list. */
  sessionIdsWithPending(): string[] {
    const rows = this.database.db
      .prepare<{ session_id: string }, []>(
        'SELECT DISTINCT session_id FROM steer_queue ORDER BY session_id ASC',
      )
      .all();
    return rows.map((row) => row.session_id);
  }

  deleteForSession(sessionId: string): void {
    this.database.db.prepare('DELETE FROM steer_queue WHERE session_id = ?').run(sessionId);
  }
}
