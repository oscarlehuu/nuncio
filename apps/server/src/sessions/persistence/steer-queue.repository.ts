import { Injectable } from '@nestjs/common';
import type { AgentAttachment } from '../../agents/agents.types';
import { DatabaseService } from '../../db/database.service';

interface SteerQueueRow {
  id: number;
  session_id: string;
  message: string;
  attachments_json: string | null;
  created_at: number;
  claimed_at: number | null;
  origin: string | null;
  failure_context_json: string | null;
  failure_reported_at: number | null;
}

export interface QueuedSteer {
  message: string;
  attachments?: AgentAttachment[];
  /** Provenance (e.g. 'task-digest') stamped onto the delivered steer_message. */
  origin?: string;
  /** Durable routing data used to report a failed background delivery after restart. */
  failureContext?: Record<string, unknown>;
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

function parseFailureContext(raw: string | null): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

/** Durable FIFO of steers accepted while a session was RUNNING (survives restarts). */
@Injectable()
export class SteerQueueRepository {
  constructor(private readonly database: DatabaseService) {}

  enqueue(
    sessionId: string,
    message: string,
    attachments?: AgentAttachment[],
    origin?: string,
    failureContext?: Record<string, unknown>,
  ): number {
    const result = this.database.db
      .prepare(
        `INSERT INTO steer_queue
         (session_id, message, attachments_json, created_at, origin, failure_context_json)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        sessionId,
        message,
        attachments && attachments.length > 0 ? JSON.stringify(attachments) : null,
        Date.now(),
        origin ?? null,
        failureContext ? JSON.stringify(failureContext) : null,
      );
    return Number(result.lastInsertRowid);
  }

  /**
   * Read the oldest UNCLAIMED queued steer WITH its id, without deleting it.
   * Lets the drain decide (deliver vs. transactionally skip a task-digest wake
   * on ERROR/PAUSED) before the row leaves the queue. Claimed rows are leased to
   * an in-flight fan-out and stay invisible.
   */
  peekNext(sessionId: string): (QueuedSteer & { id: number }) | null {
    const row = this.database.db
      .prepare<SteerQueueRow, [string]>(
        'SELECT * FROM steer_queue WHERE session_id = ? AND claimed_at IS NULL ORDER BY id ASC LIMIT 1',
      )
      .get(sessionId);
    if (!row) return null;
    const attachments = parseAttachments(row.attachments_json);
    const failureContext = parseFailureContext(row.failure_context_json);
    return {
      id: row.id,
      message: row.message,
      ...(attachments ? { attachments } : {}),
      ...(row.origin ? { origin: row.origin } : {}),
      ...(failureContext ? { failureContext } : {}),
    };
  }

  /** Delete a single row by id (no-op if already gone). */
  deleteById(id: number): void {
    this.database.db.prepare('DELETE FROM steer_queue WHERE id = ?').run(id);
  }

  /** Persist a failure report and its once-only marker in one SQLite transaction. */
  reportFailureOnce(id: number, report: () => void): boolean {
    return this.database.transaction(() => {
      const row = this.database.db
        .prepare<{ failure_reported_at: number | null }, [number]>(
          'SELECT failure_reported_at FROM steer_queue WHERE id = ?',
        )
        .get(id);
      if (!row || row.failure_reported_at !== null) return false;
      report();
      const marked = this.database.db
        .prepare(
          `UPDATE steer_queue SET failure_reported_at = ?
           WHERE id = ? AND failure_reported_at IS NULL`,
        )
        .run(Date.now(), id);
      if (marked.changes !== 1) throw new Error(`Steer queue row ${id} changed during reporting`);
      return true;
    });
  }

  /** Delete a delivered row and resolve its prior failure signal atomically. */
  acknowledgeDelivered(
    id: number,
    onRecovered: (context: Record<string, unknown>) => void,
  ): boolean {
    return this.database.transaction(() => {
      const row = this.database.db
        .prepare<SteerQueueRow, [number]>('SELECT * FROM steer_queue WHERE id = ?')
        .get(id);
      if (!row) return false;
      if (row.failure_reported_at !== null) {
        const context = parseFailureContext(row.failure_context_json);
        if (context) onRecovered(context);
      }
      this.database.db.prepare('DELETE FROM steer_queue WHERE id = ?').run(id);
      return true;
    });
  }

  /**
   * Run `fn` in one SQLite transaction. Exposed so a caller can bundle a steer
   * row delete with another same-db write (e.g. a suppression event) atomically.
   */
  transaction<T>(fn: () => T): T {
    return this.database.transaction(fn);
  }

  /**
   * Pop the oldest UNCLAIMED queued steer for the session; null when none are
   * available. Claimed rows are leased to an in-flight multitask fan-out and
   * are invisible to the normal settle-drain so a message is never delivered
   * twice.
   */
  dequeue(sessionId: string): QueuedSteer | null {
    const row = this.database.db
      .prepare<SteerQueueRow, [string]>(
        'SELECT * FROM steer_queue WHERE session_id = ? AND claimed_at IS NULL ORDER BY id ASC LIMIT 1',
      )
      .get(sessionId);
    if (!row) return null;
    this.database.db.prepare('DELETE FROM steer_queue WHERE id = ?').run(row.id);
    const attachments = parseAttachments(row.attachments_json);
    const failureContext = parseFailureContext(row.failure_context_json);
    return {
      message: row.message,
      ...(attachments ? { attachments } : {}),
      ...(row.origin ? { origin: row.origin } : {}),
      ...(failureContext ? { failureContext } : {}),
    };
  }

  /**
   * Atomically claim (lease) every currently-unclaimed row for the session and
   * return the claimed rows with ids, in FIFO order. A claim hides the rows
   * from the normal settle-drain, so a multitask fan-out can do async work
   * without the same messages being delivered again. The caller must later
   * delete the claimed ids (success) or release them (failure). Synchronous.
   */
  claimAll(sessionId: string): Array<QueuedSteer & { id: number }> {
    const now = Date.now();
    // Auto-steer wakes (origin 'task-digest') are NOT user work items — a
    // multitask fan-out must not convert a queued digest into a child prompt,
    // so they are left unclaimed for the normal settle-drain.
    const rows = this.database.db
      .prepare<SteerQueueRow, [number, string]>(
        `UPDATE steer_queue SET claimed_at = ?
         WHERE session_id = ? AND claimed_at IS NULL
           AND (origin IS NULL OR (origin != 'task-digest' AND origin NOT LIKE 'forge:%'))
         RETURNING *`,
      )
      .all(now, sessionId)
      .sort((a, b) => a.id - b.id);
    return rows.map((row) => {
      const attachments = parseAttachments(row.attachments_json);
      return { id: row.id, message: row.message, ...(attachments ? { attachments } : {}) };
    });
  }

  /** Release a claim on the given ids, returning them to normal delivery. */
  releaseByIds(ids: number[]): void {
    if (ids.length === 0) return;
    const placeholders = ids.map(() => '?').join(', ');
    this.database.db
      .prepare(`UPDATE steer_queue SET claimed_at = NULL WHERE id IN (${placeholders})`)
      .run(...ids);
  }

  /** Boot recovery: a crash can leave rows leased forever — claims never outlive a process. */
  releaseAllClaims(): void {
    this.database.db.prepare('UPDATE steer_queue SET claimed_at = NULL WHERE claimed_at IS NOT NULL').run();
  }

  /** Delete exactly the given row ids (no-op on an empty list). */
  deleteByIds(ids: number[]): void {
    if (ids.length === 0) return;
    const placeholders = ids.map(() => '?').join(', ');
    this.database.db.prepare(`DELETE FROM steer_queue WHERE id IN (${placeholders})`).run(...ids);
  }

  /** Pending rows for the session carrying the given origin (e.g. queued auto-steer wakes). */
  countByOrigin(sessionId: string, origin: string): number {
    const row = this.database.db
      .prepare<{ total: number }, [string, string]>(
        'SELECT COUNT(*) AS total FROM steer_queue WHERE session_id = ? AND origin = ?',
      )
      .get(sessionId, origin);
    return row?.total ?? 0;
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
