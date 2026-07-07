import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../db/database.service';
import type { Digest, DigestRunDto, DigestVariant } from './heartbeat.types';

/**
 * Durable digest markers (ADR-006). One row per SENT slot
 * (`slot_key = '<YYYY-MM-DD>:<morning|evening>'`) — the record that makes the
 * digest not-double-sent on a missed-fire catch-up, carries the since-last
 * window, and backs the in-app read. Closed-guarded like every repo.
 *
 * RED until implemented — neutral TODO, no false greens.
 */
@Injectable()
export class DigestRepository {
  constructor(private readonly database: DatabaseService) {}

  /** Record a sent slot (idempotent — a second write of the same slot is a no-op). */
  markSent(input: {
    slotKey: string;
    variant: DigestVariant;
    sentAt: number;
    windowFrom: number;
    windowTo: number;
    digest: Digest;
  }): DigestRunDto {
    throw new Error('TODO: DigestRepository.markSent not implemented');
    void input;
  }

  /** True when this slot has already been sent (double-send guard). */
  wasSent(slotKey: string): boolean {
    throw new Error('TODO: DigestRepository.wasSent not implemented');
    void slotKey;
  }

  /** The most-recent sent marker, or null — drives the since-last window + in-app read. */
  latest(): DigestRunDto | null {
    throw new Error('TODO: DigestRepository.latest not implemented');
  }

  findBySlot(slotKey: string): DigestRunDto | null {
    throw new Error('TODO: DigestRepository.findBySlot not implemented');
    void slotKey;
  }
}
