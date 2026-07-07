import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../db/database.service';
import type { Digest, DigestRunDto, DigestRunRow, DigestVariant } from './heartbeat.types';

function rowToDto(row: DigestRunRow): DigestRunDto {
  return {
    slotKey: row.slot_key,
    variant: row.variant as DigestVariant,
    sentAt: row.sent_at,
    windowFrom: row.window_from,
    windowTo: row.window_to,
    digest: JSON.parse(row.summary_json) as Digest,
  };
}

/**
 * Durable digest markers (ADR-006). One row per SENT slot
 * (`slot_key = '<YYYY-MM-DD>:<morning|evening>'`) — the record that makes the
 * digest not-double-sent on a missed-fire catch-up, carries the since-last
 * window, and backs the in-app read. Closed-guarded like every repo.
 */
@Injectable()
export class DigestRepository {
  constructor(private readonly database: DatabaseService) {}

  /**
   * Record a sent slot. Idempotent — `slot_key` is the PRIMARY KEY, so a second
   * markSent of the same slot is ON CONFLICT DO NOTHING (the first send wins; the
   * catch-up fire after a restart never re-sends or rewrites the window).
   */
  markSent(input: {
    slotKey: string;
    variant: DigestVariant;
    sentAt: number;
    windowFrom: number;
    windowTo: number;
    digest: Digest;
  }): DigestRunDto {
    if (!this.database.closed) {
      this.database.db
        .prepare(
          `INSERT INTO digest_runs
             (slot_key, variant, sent_at, window_from, window_to, summary_json)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(slot_key) DO NOTHING`,
        )
        .run(
          input.slotKey,
          input.variant,
          input.sentAt,
          input.windowFrom,
          input.windowTo,
          JSON.stringify(input.digest),
        );
    }
    return (
      this.findBySlot(input.slotKey) ?? {
        slotKey: input.slotKey,
        variant: input.variant,
        sentAt: input.sentAt,
        windowFrom: input.windowFrom,
        windowTo: input.windowTo,
        digest: input.digest,
      }
    );
  }

  /** True when this slot has already been sent (double-send guard). */
  wasSent(slotKey: string): boolean {
    if (this.database.closed) return false;
    const row = this.database.db
      .prepare('SELECT COUNT(*) AS n FROM digest_runs WHERE slot_key = ?')
      .get(slotKey) as { n: number } | undefined;
    return (row?.n ?? 0) > 0;
  }

  /** The most-recent sent marker, or null — drives the since-last window + in-app read. */
  latest(): DigestRunDto | null {
    if (this.database.closed) return null;
    const row = this.database.db
      .prepare('SELECT * FROM digest_runs ORDER BY sent_at DESC LIMIT 1')
      .get() as DigestRunRow | undefined;
    return row ? rowToDto(row) : null;
  }

  findBySlot(slotKey: string): DigestRunDto | null {
    if (this.database.closed) return null;
    const row = this.database.db
      .prepare('SELECT * FROM digest_runs WHERE slot_key = ?')
      .get(slotKey) as DigestRunRow | undefined;
    return row ? rowToDto(row) : null;
  }
}
