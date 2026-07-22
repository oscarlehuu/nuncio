import 'reflect-metadata';
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseService } from '../../../src/db/database.service';
import { SchedulerService } from '../../../src/scheduler/scheduler.service';
import { SchedulesRepository } from '../../../src/scheduler/schedules.repository';

describe('SchedulerService system intent lease lifecycle', () => {
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

  it('renews a live lease so a later boot cannot invoke concurrently', async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-scheduler-system-renewal-'));
    process.env.NUNCIO_DATA_DIR = dataDir;
    first = new DatabaseService();
    const firstSchedules = new SchedulesRepository(first);
    const owner = new SchedulerService(firstSchedules);
    const schedule = owner.create({
      kind: 'heartbeat',
      spec: 'every:15m',
      target: { kind: 'system', job: 'infra' },
    });
    const firedAt = schedule.nextFireAt ?? Date.now();
    const intent = firstSchedules.dispatches.begin(
      schedule,
      firedAt,
      'ok',
      firedAt + 900_000,
      null,
    );
    owner.systemDispatchLeaseMs = 120;
    owner.systemDispatchHeartbeatMs = 20;
    let release!: () => void;
    const handlerGate = new Promise<void>((resolve) => { release = resolve; });
    let ownerCalls = 0;
    owner.setSystemFireHandler(() => {
      ownerCalls += 1;
      return handlerGate;
    });

    second = new DatabaseService();
    const contender = new SchedulerService(new SchedulesRepository(second));
    contender.systemDispatchLeaseMs = 120;
    contender.systemDispatchHeartbeatMs = 20;
    let contenderCalls = 0;
    contender.setSystemFireHandler(() => { contenderCalls += 1; });
    try {
      owner.onModuleInit();
      owner.onApplicationBootstrap();
      await Bun.sleep(180);
      expect(ownerCalls).toBe(1);

      contender.onModuleInit();
      contender.onApplicationBootstrap();
      await Bun.sleep(30);
      expect(contenderCalls).toBe(0);

      release();
      const deadline = Date.now() + 1_000;
      while (Date.now() < deadline) {
        const status = first.db.prepare<{ status: string }, [string]>(
          'SELECT status FROM schedule_dispatch_intents WHERE id = ?',
        ).get(intent.id)?.status;
        if (status === 'completed') break;
        await Bun.sleep(5);
      }
      expect(first.db.prepare<{ status: string }, [string]>(
        'SELECT status FROM schedule_dispatch_intents WHERE id = ?',
      ).get(intent.id)?.status).toBe('completed');
    } finally {
      owner.onModuleDestroy();
      contender.onModuleDestroy();
    }
  });

  it('reclaims an abandoned lease on boot and invokes the handler once', async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-scheduler-system-recovery-'));
    process.env.NUNCIO_DATA_DIR = dataDir;
    first = new DatabaseService();
    const firstSchedules = new SchedulesRepository(first);
    const seedScheduler = new SchedulerService(firstSchedules);
    seedScheduler.clock = { now: () => 0 };
    const schedule = seedScheduler.create({
      kind: 'heartbeat',
      spec: 'every:15m',
      target: { kind: 'system', job: 'infra' },
    });
    const intent = firstSchedules.dispatches.begin(schedule, 900_000, 'ok', 1_800_000, null);
    const abandoned = firstSchedules.dispatches.claimSystem(intent, 100, 50);
    expect(abandoned.status).toBe('claimed');
    seedScheduler.onModuleDestroy();
    first.onModuleDestroy();
    first = null;

    second = new DatabaseService();
    const recoveredScheduler = new SchedulerService(new SchedulesRepository(second));
    let calls = 0;
    recoveredScheduler.clock = { now: () => 150 };
    recoveredScheduler.setSystemFireHandler((job) => {
      expect(job).toBe('infra');
      calls += 1;
    });
    try {
      recoveredScheduler.onModuleInit();
      recoveredScheduler.onApplicationBootstrap();
      await Bun.sleep(0);
      expect(calls).toBe(1);
      expect(second.db.prepare<{ status: string }, [string]>(
        'SELECT status FROM schedule_dispatch_intents WHERE id = ?',
      ).get(intent.id)?.status).toBe('completed');
    } finally {
      recoveredScheduler.onModuleDestroy();
    }
  });
});
