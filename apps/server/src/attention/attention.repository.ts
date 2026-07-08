import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../db/database.service';
import type { AttentionItemDto, AttentionItemRow, AttentionStatus } from './attention.types';

function rowToDto(row: AttentionItemRow): AttentionItemDto {
  return {
    id: row.id,
    kind: row.kind,
    subjectId: row.subject_id,
    projectPath: row.project_path,
    severity: row.severity,
    title: row.title,
    payload: row.payload_json ? (JSON.parse(row.payload_json) as Record<string, unknown>) : null,
    status: row.status as AttentionStatus,
    acknowledgedAt: row.acknowledged_at,
    suppressReraise: row.suppress_reraise === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    resolvedAt: row.resolved_at,
  };
}

/**
 * Durable attention_items store (ADR-006). One OPEN row per (kind, subjectId) —
 * enforced by a partial UNIQUE index over `status='open'` so a re-signal can
 * never stack, while a resolved row does not block a later re-trip. Restart-safe:
 * rows persist; open items are reconciled against live state on boot. Every write
 * passes the `database.closed` funnel guard like the rest of the repositories.
 */
@Injectable()
export class AttentionRepository {
  constructor(private readonly database: DatabaseService) {}

  /**
   * Upsert-open: insert a fresh open item, or bump the existing open one for the
   * same (kind, subjectId) — dedup, no stacking. Because the UNIQUE index is
   * partial over open rows, a resolved row for the same condition does NOT trip
   * the conflict, so a re-trip after resolve inserts a genuinely new open row.
   */
  raise(input: {
    id: string;
    kind: string;
    subjectId: string;
    projectPath: string | null;
    severity: number;
    title: string;
    payloadJson: string | null;
    now: number;
  }): AttentionItemDto {
    // DB closing during shutdown — no-op the write and hand back an in-memory
    // shape (the caller's badge emit won't touch the closed handle).
    if (this.database.closed) {
      return {
        id: input.id,
        kind: input.kind,
        subjectId: input.subjectId,
        projectPath: input.projectPath,
        severity: input.severity,
        title: input.title,
        payload: input.payloadJson ? (JSON.parse(input.payloadJson) as Record<string, unknown>) : null,
        status: 'open',
        acknowledgedAt: null,
        suppressReraise: false,
        createdAt: input.now,
        updatedAt: input.now,
        resolvedAt: null,
      };
    }
    const existing = this.findOpen(input.kind, input.subjectId);
    if (existing) {
      // Idempotent bump of the already-open item (no second row).
      this.database.db
        .prepare(
          `UPDATE attention_items
             SET title = ?, project_path = ?, severity = ?, payload_json = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          input.title,
          input.projectPath,
          input.severity,
          input.payloadJson,
          input.now,
          existing.id,
        );
      return this.findById(existing.id)!;
    }
    this.database.db
      .prepare(
        `INSERT INTO attention_items
           (id, kind, subject_id, project_path, severity, title, payload_json,
            status, acknowledged_at, created_at, updated_at, resolved_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'open', NULL, ?, ?, NULL)`,
      )
      .run(
        input.id,
        input.kind,
        input.subjectId,
        input.projectPath,
        input.severity,
        input.title,
        input.payloadJson,
        input.now,
        input.now,
      );
    return this.findById(input.id)!;
  }

  findById(id: string): AttentionItemDto | null {
    if (this.database.closed) return null;
    const row = this.database.db
      .prepare('SELECT * FROM attention_items WHERE id = ?')
      .get(id) as AttentionItemRow | undefined;
    return row ? rowToDto(row) : null;
  }

  /** The one OPEN item for a condition, or null. Drives dedup + auto-resolve. */
  findOpen(kind: string, subjectId: string): AttentionItemDto | null {
    if (this.database.closed) return null;
    const row = this.database.db
      .prepare("SELECT * FROM attention_items WHERE kind = ? AND subject_id = ? AND status = 'open'")
      .get(kind, subjectId) as AttentionItemRow | undefined;
    return row ? rowToDto(row) : null;
  }

  /**
   * The most-recent item for a condition regardless of status — drives the
   * re-raise-suppression check (was the last resolve a founder override still in
   * force?). Newest by updated_at, then created_at.
   */
  findLatest(kind: string, subjectId: string): AttentionItemDto | null {
    if (this.database.closed) return null;
    const row = this.database.db
      .prepare(
        `SELECT * FROM attention_items
           WHERE kind = ? AND subject_id = ?
           ORDER BY updated_at DESC, created_at DESC LIMIT 1`,
      )
      .get(kind, subjectId) as AttentionItemRow | undefined;
    return row ? rowToDto(row) : null;
  }

  /** Set/clear the suppress-reraise marker on every row for a condition. */
  setSuppressReraise(kind: string, subjectId: string, suppress: boolean, now: number): void {
    if (this.database.closed) return;
    this.database.db
      .prepare(
        'UPDATE attention_items SET suppress_reraise = ?, updated_at = ? WHERE kind = ? AND subject_id = ?',
      )
      .run(suppress ? 1 : 0, now, kind, subjectId);
  }

  list(status?: AttentionStatus): AttentionItemDto[] {
    if (this.database.closed) return [];
    const rows = (
      status
        ? this.database.db
            .prepare('SELECT * FROM attention_items WHERE status = ? ORDER BY created_at ASC')
            .all(status)
        : this.database.db
            .prepare('SELECT * FROM attention_items ORDER BY created_at ASC')
            .all()
    ) as AttentionItemRow[];
    return rows.map(rowToDto);
  }

  /** Set acknowledged_at; the item stays OPEN (ack = seen, not resolved). */
  acknowledge(id: string, now: number): AttentionItemDto | null {
    if (this.database.closed) return this.findById(id);
    this.database.db
      .prepare('UPDATE attention_items SET acknowledged_at = ?, updated_at = ? WHERE id = ?')
      .run(now, now, id);
    return this.findById(id);
  }

  /** Replace kind-specific detail without changing open/resolved state. */
  updatePayload(id: string, payload: Record<string, unknown> | null, now: number): AttentionItemDto | null {
    if (this.database.closed) return this.findById(id);
    this.database.db
      .prepare('UPDATE attention_items SET payload_json = ?, updated_at = ? WHERE id = ?')
      .run(payload ? JSON.stringify(payload) : null, now, id);
    return this.findById(id);
  }

  /**
   * Terminal: status → resolved, resolved_at set (auto or manual). Idempotent —
   * re-resolving keeps the original resolved_at so a double-tap on a laggy phone
   * link never rewrites the timestamp.
   */
  resolve(id: string, now: number): AttentionItemDto | null {
    if (this.database.closed) return this.findById(id);
    this.database.db
      .prepare(
        `UPDATE attention_items
           SET status = 'resolved',
               resolved_at = COALESCE(resolved_at, ?),
               updated_at = ?
         WHERE id = ?`,
      )
      .run(now, now, id);
    return this.findById(id);
  }
}
