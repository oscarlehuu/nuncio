import 'reflect-metadata';
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseService } from '../../../src/db/database.service';
import { SchedulerService } from '../../../src/scheduler/scheduler.service';
import { SchedulesRepository } from '../../../src/scheduler/schedules.repository';

describe('ScheduleDispatchIntentsRepository system leases', () => {
  let dataDir = '';
  let first: DatabaseService | null = null;
  let second: DatabaseService | null = null;

  afterEach(() => {
    if (first && !first.closed) first.onModuleDestroy();
    if (second && !second.closed) second.onModuleDestroy();
    first = null;
    second = null;
    delete process.env.NUNCIO_DATA_DIR;
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
    dataDir = '';
  });

  it('recovers at exact lease expiry and fences the stale token from renew and settlement', () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-scheduler-system-lease-'));
    process.env.NUNCIO_DATA_DIR = dataDir;
    first = new DatabaseService();
    const firstSchedules = new SchedulesRepository(first);
    const scheduler = new SchedulerService(firstSchedules);
    scheduler.clock = { now: () => 0 };
    const schedule = scheduler.create({
      kind: 'heartbeat',
      spec: 'every:15m',
      target: { kind: 'system', job: 'infra' },
    });
    const intent = firstSchedules.dispatches.begin(schedule, 900_000, 'ok', 1_800_000, null);
    scheduler.onModuleDestroy();

    second = new DatabaseService();
    const secondDispatches = new SchedulesRepository(second).dispatches;
    const firstClaim = firstSchedules.dispatches.claimSystem(intent, 100, 50);
    expect(firstClaim.status).toBe('claimed');
    if (firstClaim.status !== 'claimed') return;

    expect(secondDispatches.claimSystem(intent, 149, 50)).toEqual({
      status: 'in-progress', retryAt: 150,
    });
    expect(firstSchedules.dispatches.renewSystemClaim(firstClaim.claim, 149, 50)).toBe(true);
    expect(secondDispatches.claimSystem(intent, 198, 50)).toEqual({
      status: 'in-progress', retryAt: 199,
    });

    const secondClaim = secondDispatches.claimSystem(intent, 199, 50);
    expect(secondClaim.status).toBe('claimed');
    if (secondClaim.status !== 'claimed') return;
    expect(secondClaim.claim.token).not.toBe(firstClaim.claim.token);

    expect(firstSchedules.dispatches.renewSystemClaim(firstClaim.claim, 199, 50)).toBe(false);
    expect(firstSchedules.dispatches.settleSystem(intent, null, firstClaim.claim, 199)).toBe(false);
    expect(secondDispatches.renewSystemClaim(secondClaim.claim, 200, 50)).toBe(true);
    expect(secondDispatches.settleSystem(intent, null, secondClaim.claim, 200)).toBe(true);

    expect(first.db.prepare<
      { status: string; claim_token: string | null; lease_expires_at: number | null },
      [string]
    >(
      'SELECT status, claim_token, lease_expires_at FROM schedule_dispatch_intents WHERE id = ?',
    ).get(intent.id)).toEqual({ status: 'completed', claim_token: null, lease_expires_at: null });
  });

  it('bounds zero and negative lease durations to a reclaimable one-millisecond window', () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-scheduler-system-lease-bound-'));
    process.env.NUNCIO_DATA_DIR = dataDir;
    first = new DatabaseService();
    const firstSchedules = new SchedulesRepository(first);
    const scheduler = new SchedulerService(firstSchedules);
    scheduler.clock = { now: () => 0 };
    const schedule = scheduler.create({
      kind: 'heartbeat',
      spec: 'every:15m',
      target: { kind: 'system', job: 'infra' },
    });
    const intent = firstSchedules.dispatches.begin(schedule, 900_000, 'ok', 1_800_000, null);
    scheduler.onModuleDestroy();

    second = new DatabaseService();
    const secondDispatches = new SchedulesRepository(second).dispatches;
    expect(firstSchedules.dispatches.claimSystem(intent, 100, 0).status).toBe('claimed');
    expect(first.db.prepare<{ lease_expires_at: number }, [string]>(
      'SELECT lease_expires_at FROM schedule_dispatch_intents WHERE id = ?',
    ).get(intent.id)?.lease_expires_at).toBe(101);

    expect(secondDispatches.claimSystem(intent, 101, -5).status).toBe('claimed');
    expect(second.db.prepare<{ lease_expires_at: number }, [string]>(
      'SELECT lease_expires_at FROM schedule_dispatch_intents WHERE id = ?',
    ).get(intent.id)?.lease_expires_at).toBe(102);
  });
});
