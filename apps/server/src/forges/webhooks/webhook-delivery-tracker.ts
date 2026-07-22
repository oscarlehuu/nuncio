import { randomUUID } from 'node:crypto';
import type { DatabaseService } from '../../db/database.service';

const DELIVERY_LEASE_MS = 60_000;

interface DeliveryRow {
  status: 'processing' | 'retryable' | 'completed';
  claim_token: string | null;
  lease_expires_at: number | null;
  checkpoint: string | null;
  accepted_session_id: string | null;
}

export interface WebhookDeliveryClaim {
  provider: string;
  deliveryId: string;
  token: string;
  retrying: boolean;
  checkpoint: string | null;
  sessionId: string | null;
}

export type WebhookDeliveryClaimResult =
  | { status: 'claimed'; claim: WebhookDeliveryClaim }
  | { status: 'completed' }
  | { status: 'in-progress' };

export type WebhookDeliveryAcceptance = <T>(work: () => T) => T;

/** Leases webhook processing and commits completion with its durable terminal write. */
export class WebhookDeliveryTracker {
  leaseMs = DELIVERY_LEASE_MS;
  clock = { now: () => Date.now() };

  constructor(private readonly database: DatabaseService) {}

  claim(provider: string, deliveryId: string): WebhookDeliveryClaimResult {
    return this.database.immediateTransaction(() => {
      const now = this.clock.now();
      const token = randomUUID();
      const leaseExpiresAt = now + this.leaseMs;
      const inserted = this.database.db
        .prepare(
          `INSERT OR IGNORE INTO forge_webhook_deliveries
           (provider, delivery_id, created_at, status, claim_token, lease_expires_at, updated_at)
           VALUES (?, ?, ?, 'processing', ?, ?, ?)`,
        )
        .run(provider, deliveryId, now, token, leaseExpiresAt, now);
      if (inserted.changes === 1) {
        return {
          status: 'claimed' as const,
          claim: {
            provider,
            deliveryId,
            token,
            retrying: false,
            checkpoint: null,
            sessionId: null,
          },
        };
      }

      const row = this.database.db
        .prepare<DeliveryRow, [string, string]>(
          `SELECT status, claim_token, lease_expires_at, checkpoint, accepted_session_id
           FROM forge_webhook_deliveries WHERE provider = ? AND delivery_id = ?`,
        )
        .get(provider, deliveryId);
      if (!row || row.status === 'completed') return { status: 'completed' as const };
      if (row.status === 'processing' && (row.lease_expires_at ?? 0) > now) {
        return { status: 'in-progress' as const };
      }

      const reclaimed = this.database.db
        .prepare(
          `UPDATE forge_webhook_deliveries
           SET status = 'processing', claim_token = ?, lease_expires_at = ?, updated_at = ?
           WHERE provider = ? AND delivery_id = ? AND status != 'completed'
             AND (status != 'processing' OR lease_expires_at IS NULL OR lease_expires_at <= ?)`,
        )
        .run(token, leaseExpiresAt, now, provider, deliveryId, now);
      return reclaimed.changes === 1
        ? {
            status: 'claimed' as const,
            claim: {
              provider,
              deliveryId,
              token,
              retrying: true,
              checkpoint: row.checkpoint,
              sessionId: row.accepted_session_id,
            },
          }
        : { status: 'in-progress' as const };
    });
  }

  complete<T>(claim: WebhookDeliveryClaim, work: () => T): T {
    return this.database.immediateTransaction(() => {
      this.assertOwned(claim);
      const result = work();
      const completed = this.database.db
        .prepare(
          `UPDATE forge_webhook_deliveries
           SET status = 'completed', claim_token = NULL, lease_expires_at = NULL, updated_at = ?
           WHERE provider = ? AND delivery_id = ? AND status = 'processing'
             AND claim_token = ? AND lease_expires_at > ?`,
        )
        .run(
          this.clock.now(), claim.provider, claim.deliveryId, claim.token, this.clock.now(),
        );
      if (completed.changes !== 1) throw new Error('Webhook delivery claim is no longer owned');
      return result;
    });
  }

  assertOwned(claim: WebhookDeliveryClaim): void {
    const owned = this.database.db
      .prepare<{ owned: number }, [string, string, string, number]>(
        `SELECT 1 AS owned FROM forge_webhook_deliveries
         WHERE provider = ? AND delivery_id = ?
           AND status = 'processing' AND claim_token = ? AND lease_expires_at > ?`,
      )
      .get(claim.provider, claim.deliveryId, claim.token, this.clock.now());
    if (!owned) throw new Error('Webhook delivery claim is no longer owned');
  }

  renew(claim: WebhookDeliveryClaim): boolean {
    return this.database.immediateTransaction(() => {
      const now = this.clock.now();
      const renewed = this.database.db
        .prepare(
          `UPDATE forge_webhook_deliveries SET lease_expires_at = ?, updated_at = ?
           WHERE provider = ? AND delivery_id = ?
             AND status = 'processing' AND claim_token = ? AND lease_expires_at > ?`,
        )
        .run(
          now + this.leaseMs,
          now,
          claim.provider,
          claim.deliveryId,
          claim.token,
          now,
        );
      return renewed.changes === 1;
    });
  }

  markCheckpoint(claim: WebhookDeliveryClaim, checkpoint: string): void {
    const updated = this.database.db
      .prepare(
        `UPDATE forge_webhook_deliveries SET checkpoint = ?, updated_at = ?
         WHERE provider = ? AND delivery_id = ?
           AND status = 'processing' AND claim_token = ? AND lease_expires_at > ?`,
      )
      .run(
        checkpoint,
        this.clock.now(),
        claim.provider,
        claim.deliveryId,
        claim.token,
        this.clock.now(),
      );
    if (updated.changes !== 1) throw new Error('Webhook delivery claim is no longer owned');
    claim.checkpoint = checkpoint;
  }

  reserveSessionId(claim: WebhookDeliveryClaim): string {
    if (claim.sessionId) return claim.sessionId;
    const sessionId = randomUUID().slice(0, 8);
    const updated = this.database.db
      .prepare(
        `UPDATE forge_webhook_deliveries SET accepted_session_id = ?, updated_at = ?
         WHERE provider = ? AND delivery_id = ?
           AND status = 'processing' AND claim_token = ? AND accepted_session_id IS NULL
           AND lease_expires_at > ?`,
      )
      .run(
        sessionId,
        this.clock.now(),
        claim.provider,
        claim.deliveryId,
        claim.token,
        this.clock.now(),
      );
    if (updated.changes !== 1) throw new Error('Webhook delivery claim is no longer owned');
    claim.sessionId = sessionId;
    return sessionId;
  }

  release(claim: WebhookDeliveryClaim): void {
    this.database.db
      .prepare(
        `UPDATE forge_webhook_deliveries
         SET status = 'retryable', claim_token = NULL, lease_expires_at = NULL, updated_at = ?
         WHERE provider = ? AND delivery_id = ?
           AND status = 'processing' AND claim_token = ?`,
      )
      .run(this.clock.now(), claim.provider, claim.deliveryId, claim.token);
  }
}
