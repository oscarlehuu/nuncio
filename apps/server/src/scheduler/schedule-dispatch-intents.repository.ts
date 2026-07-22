import { randomUUID } from 'node:crypto';
import type { DatabaseService } from '../db/database.service';
import {
  ScheduleDispatchClaimsRepository,
  type ScheduleDispatchClaim,
  type ScheduleDispatchClaimResult,
} from './schedule-dispatch-claims.repository';
import type {
  FireResult,
  LoopTriggerContext,
  ScheduleDto,
  ScheduleTarget,
} from './scheduler.types';

export type { ScheduleDispatchClaim, ScheduleDispatchClaimResult } from './schedule-dispatch-claims.repository';

type ScheduleDispatchIntentStatus = 'pending' | 'completed' | 'error' | 'tombstoned';

interface DispatchIntentRow {
  id: string;
  schedule_id: string;
  generation: number;
  fired_at: number;
  initial_result: 'ok' | 'missed';
  next_fire_at: number | null;
  target_json: string;
  trigger_json: string | null;
  status: ScheduleDispatchIntentStatus;
  claim_token: string | null;
  lease_expires_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface ScheduleDispatchIntent {
  id: string;
  scheduleId: string;
  generation: number;
  firedAt: number;
  initialResult: 'ok' | 'missed';
  nextFireAt: number | null;
  target: ScheduleTarget;
  trigger: LoopTriggerContext | null;
  status: ScheduleDispatchIntentStatus;
}

export interface ScheduleDispatchTargetReceipt {
  targetKind: 'task' | 'loop-run';
  targetId: string;
}

export class ScheduleDispatchIntentsRepository {
  private readonly claims: ScheduleDispatchClaimsRepository;

  constructor(private readonly database: DatabaseService) {
    this.claims = new ScheduleDispatchClaimsRepository(database);
  }

  begin(
    schedule: ScheduleDto,
    firedAt: number,
    initialResult: 'ok' | 'missed',
    nextFireAt: number | null,
    trigger: LoopTriggerContext | null,
  ): ScheduleDispatchIntent {
    return this.database.immediateTransaction(() => {
      const now = Date.now();
      const acknowledged = this.database.db.prepare(
        `UPDATE schedules
         SET last_fire_at = ?, last_result = ?, next_fire_at = ?, updated_at = ?
         WHERE id = ? AND generation = ? AND next_fire_at IS ?`,
      ).run(
        firedAt,
        initialResult,
        nextFireAt,
        now,
        schedule.id,
        schedule.generation,
        schedule.nextFireAt,
      );
      if (acknowledged.changes !== 1) {
        throw new Error(`Schedule ${schedule.id} due cursor or generation was already claimed`);
      }
      const id = randomUUID();
      this.database.db.prepare(
        `INSERT INTO schedule_dispatch_intents
         (id, schedule_id, generation, fired_at, initial_result, next_fire_at,
          target_json, trigger_json, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      ).run(
        id,
        schedule.id,
        schedule.generation,
        firedAt,
        initialResult,
        nextFireAt,
        JSON.stringify(schedule.target),
        trigger ? JSON.stringify(trigger) : null,
        now,
        now,
      );
      return {
        id,
        scheduleId: schedule.id,
        generation: schedule.generation,
        firedAt,
        initialResult,
        nextFireAt,
        target: schedule.target,
        trigger,
        status: 'pending',
      };
    });
  }

  listPending(): ScheduleDispatchIntent[] {
    if (this.database.closed) return [];
    return this.database.db.prepare<DispatchIntentRow, []>(
      "SELECT * FROM schedule_dispatch_intents WHERE status = 'pending' ORDER BY created_at, rowid",
    ).all().map(toDto);
  }

  findOldestPending(scheduleId: string): ScheduleDispatchIntent | null {
    if (this.database.closed) return null;
    const row = this.database.db.prepare<DispatchIntentRow, [string]>(
      `SELECT * FROM schedule_dispatch_intents
       WHERE status = 'pending' AND schedule_id = ?
       ORDER BY created_at, rowid LIMIT 1`,
    ).get(scheduleId);
    return row ? toDto(row) : null;
  }

  findTargetReceipt(intent: ScheduleDispatchIntent): ScheduleDispatchTargetReceipt | null {
    if (this.database.closed) return null;
    if (intent.target.kind === 'task') {
      const row = this.database.db.prepare<{ id: string }, [string]>(
        'SELECT id FROM tasks WHERE schedule_dispatch_intent_id = ?',
      ).get(intent.id);
      return row ? { targetKind: 'task', targetId: row.id } : null;
    }
    if (intent.target.kind === 'loop') {
      const row = this.database.db.prepare<{ id: string }, [string]>(
        'SELECT id FROM loop_runs WHERE schedule_dispatch_intent_id = ?',
      ).get(intent.id);
      return row ? { targetKind: 'loop-run', targetId: row.id } : null;
    }
    return null;
  }

  claimSystem(
    intent: ScheduleDispatchIntent,
    now: number,
    leaseMs: number,
  ): ScheduleDispatchClaimResult {
    return this.claims.claim(intent, now, leaseMs);
  }

  renewSystemClaim(claim: ScheduleDispatchClaim, now: number, leaseMs: number): boolean {
    return this.claims.renew(claim, now, leaseMs);
  }

  settleSystem(
    intent: ScheduleDispatchIntent,
    result: FireResult | null,
    claim: ScheduleDispatchClaim,
    now: number,
  ): boolean {
    return this.claims.settle(intent, result, claim, now);
  }

  withTargetCreation<T>(intentId: string, createTarget: () => T): T {
    return this.database.withScheduleDispatchIntent(intentId, createTarget);
  }

  tombstone(intent: ScheduleDispatchIntent, now = Date.now()): boolean {
    if (this.database.closed) return false;
    const result = this.database.db.prepare(
      `UPDATE schedule_dispatch_intents
       SET status = 'tombstoned', claim_token = NULL, lease_expires_at = NULL, updated_at = ?
       WHERE id = ? AND status = 'pending'
         AND (claim_token IS NULL OR lease_expires_at IS NULL OR lease_expires_at <= ?)`,
    ).run(now, intent.id, now);
    return result.changes === 1;
  }

  settle(intent: ScheduleDispatchIntent, result: FireResult | null): boolean {
    if (this.database.closed) return false;
    return this.database.immediateTransaction(() => {
      const now = Date.now();
      const settled = this.database.db.prepare(
        `UPDATE schedule_dispatch_intents
         SET status = ?, updated_at = ?
         WHERE id = ? AND status = 'pending' AND claim_token IS NULL`,
      ).run(result ? 'error' : 'completed', now, intent.id);
      if (settled.changes !== 1) return false;
      this.recordErrorResult(intent, result, now);
      return true;
    });
  }

  private recordErrorResult(intent: ScheduleDispatchIntent, result: FireResult | null, now: number): void {
    if (!result) return;
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
}

function toDto(row: DispatchIntentRow): ScheduleDispatchIntent {
  return {
    id: row.id,
    scheduleId: row.schedule_id,
    generation: row.generation,
    firedAt: row.fired_at,
    initialResult: row.initial_result,
    nextFireAt: row.next_fire_at,
    target: JSON.parse(row.target_json) as ScheduleTarget,
    trigger: row.trigger_json ? JSON.parse(row.trigger_json) as LoopTriggerContext : null,
    status: row.status,
  };
}
