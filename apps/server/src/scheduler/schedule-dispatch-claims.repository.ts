import { randomUUID } from 'node:crypto';
import type { DatabaseService } from '../db/database.service';
import type { FireResult } from './scheduler.types';
import type { ScheduleDispatchIntent } from './schedule-dispatch-intents.repository';

export interface ScheduleDispatchClaim {
  intentId: string;
  token: string;
}

export type ScheduleDispatchClaimResult =
  | { status: 'claimed'; claim: ScheduleDispatchClaim }
  | { status: 'in-progress'; retryAt: number }
  | { status: 'unavailable' };

export class ScheduleDispatchClaimsRepository {
  constructor(private readonly database: DatabaseService) {}

  claim(
    intent: ScheduleDispatchIntent,
    now: number,
    leaseMs: number,
  ): ScheduleDispatchClaimResult {
    if (this.database.closed) return { status: 'unavailable' };
    if (intent.target.kind !== 'system') {
      throw new Error(`Dispatch intent ${intent.id} is not a system target`);
    }
    return this.database.immediateTransaction(() => {
      const token = randomUUID();
      const leaseExpiresAt = now + normalizeLeaseMs(leaseMs);
      const claimed = this.database.db.prepare(
        `UPDATE schedule_dispatch_intents
         SET claim_token = ?, lease_expires_at = ?, updated_at = ?
         WHERE id = ? AND status = 'pending'
           AND (claim_token IS NULL OR lease_expires_at IS NULL OR lease_expires_at <= ?)`,
      ).run(token, leaseExpiresAt, now, intent.id, now);
      if (claimed.changes === 1) {
        return { status: 'claimed', claim: { intentId: intent.id, token } };
      }
      const row = this.database.db.prepare<
        { status: string; lease_expires_at: number | null },
        [string]
      >(
        'SELECT status, lease_expires_at FROM schedule_dispatch_intents WHERE id = ?',
      ).get(intent.id);
      if (row?.status === 'pending' && (row.lease_expires_at ?? 0) > now) {
        return { status: 'in-progress', retryAt: row.lease_expires_at! };
      }
      return { status: 'unavailable' };
    });
  }

  renew(claim: ScheduleDispatchClaim, now: number, leaseMs: number): boolean {
    if (this.database.closed) return false;
    const renewed = this.database.db.prepare(
      `UPDATE schedule_dispatch_intents
       SET lease_expires_at = ?, updated_at = ?
       WHERE id = ? AND status = 'pending' AND claim_token = ? AND lease_expires_at > ?`,
    ).run(now + normalizeLeaseMs(leaseMs), now, claim.intentId, claim.token, now);
    return renewed.changes === 1;
  }

  settle(
    intent: ScheduleDispatchIntent,
    result: FireResult | null,
    claim: ScheduleDispatchClaim,
    now: number,
  ): boolean {
    if (this.database.closed) return false;
    return this.database.immediateTransaction(() => {
      const settled = this.database.db.prepare(
        `UPDATE schedule_dispatch_intents
         SET status = ?, claim_token = NULL, lease_expires_at = NULL, updated_at = ?
         WHERE id = ? AND status = 'pending' AND claim_token = ? AND lease_expires_at > ?`,
      ).run(result ? 'error' : 'completed', now, intent.id, claim.token, now);
      if (settled.changes !== 1) return false;
      if (result) {
        this.database.db.prepare(
          `UPDATE schedules SET last_result = ?, updated_at = ?
           WHERE id = ? AND generation = ? AND last_fire_at = ? AND next_fire_at IS ?`,
        ).run(
          result,
          now,
          intent.scheduleId,
          intent.generation,
          intent.firedAt,
          intent.nextFireAt,
        );
      }
      return true;
    });
  }
}

function normalizeLeaseMs(leaseMs: number): number {
  return Number.isFinite(leaseMs) ? Math.max(1, Math.floor(leaseMs)) : 1;
}
