import 'reflect-metadata';
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseService } from '../../../src/db/database.service';
import { SchedulerService } from '../../../src/scheduler/scheduler.service';
import { SchedulesRepository } from '../../../src/scheduler/schedules.repository';
import type { TasksService } from '../../../src/tasks/tasks.service';

function at(day: number, hour: number): number {
  return new Date(2026, 6, day, hour, 0, 0, 0).getTime();
}

describe('Scheduler dispatch cursor fencing', () => {
  let dataDir = '';
  const databases: DatabaseService[] = [];
  const schedulers: SchedulerService[] = [];

  afterEach(async () => {
    for (const scheduler of schedulers) scheduler.onModuleDestroy();
    await Promise.resolve();
    for (const database of databases) {
      if (!database.closed) database.onModuleDestroy();
    }
    schedulers.length = 0;
    databases.length = 0;
    delete process.env.NUNCIO_DATA_DIR;
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
    dataDir = '';
  });

  function openPair(): {
    firstDatabase: DatabaseService;
    firstSchedules: SchedulesRepository;
    first: SchedulerService;
    secondSchedules: SchedulesRepository;
    second: SchedulerService;
  } {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-scheduler-dispatch-fence-'));
    process.env.NUNCIO_DATA_DIR = dataDir;
    const firstDatabase = new DatabaseService();
    const secondDatabase = new DatabaseService();
    databases.push(firstDatabase, secondDatabase);
    const firstSchedules = new SchedulesRepository(firstDatabase);
    const secondSchedules = new SchedulesRepository(secondDatabase);
    const first = new SchedulerService(firstSchedules);
    const second = new SchedulerService(secondSchedules);
    schedulers.push(first, second);
    first.clock = second.clock = { now: () => at(22, 8) };
    return { firstDatabase, firstSchedules, first, secondSchedules, second };
  }

  it('rejects a stale acknowledgement but still claims an unchanged due cursor', () => {
    const { firstDatabase, firstSchedules, first, secondSchedules, second } = openPair();
    const schedule = first.create({
      kind: 'cron',
      spec: 'daily@09:00',
      target: { kind: 'task', template: { prompt: 'claim fence' } },
    });
    const stale = firstSchedules.findById(schedule.id)!;
    second.updateSpec(schedule.id, 'cron', 'daily@17:00');
    const revised = secondSchedules.findById(schedule.id)!;

    expect(() => firstSchedules.dispatches.begin(
      stale,
      stale.nextFireAt!,
      'ok',
      at(23, 9),
      null,
    )).toThrow('due cursor or generation was already claimed');
    expect(firstDatabase.db.prepare<{ count: number }, []>(
      'SELECT COUNT(*) AS count FROM schedule_dispatch_intents',
    ).get()?.count).toBe(0);
    expect(secondSchedules.findById(schedule.id)).toEqual(revised);

    const intent = firstSchedules.dispatches.begin(
      revised,
      revised.nextFireAt!,
      'ok',
      at(23, 17),
      null,
    );
    expect(intent.generation).toBe(1);
    expect(secondSchedules.findById(schedule.id)?.nextFireAt).toBe(at(23, 17));
  });

  it('fences claimed system recovery result writes after the cursor moves', () => {
    const { firstSchedules, first, secondSchedules } = openPair();
    const schedule = first.create({
      kind: 'heartbeat',
      spec: 'every:15m',
      target: { kind: 'system', job: 'infra' },
    });
    const intent = firstSchedules.dispatches.begin(
      schedule,
      schedule.nextFireAt!,
      'ok',
      schedule.nextFireAt! + 900_000,
      null,
    );
    secondSchedules.setNextFire(
      secondSchedules.findById(schedule.id)!,
      schedule.nextFireAt! + 1_800_000,
    );
    const claimed = firstSchedules.dispatches.claimSystem(intent, 100, 50);
    expect(claimed.status).toBe('claimed');
    if (claimed.status !== 'claimed') return;

    expect(firstSchedules.dispatches.settleSystem(
      intent,
      'error:recovered system failed',
      claimed.claim,
      101,
    )).toBe(true);
    expect(secondSchedules.findById(schedule.id)).toMatchObject({
      generation: 0,
      nextFireAt: schedule.nextFireAt! + 1_800_000,
      lastFireAt: schedule.nextFireAt,
      lastResult: 'ok',
    });
  });

  it('does not let stale recovery overwrite result state after the cursor moves', async () => {
    const { firstDatabase, firstSchedules, first, secondSchedules } = openPair();
    const schedule = first.create({
      kind: 'cron',
      spec: 'daily@09:00',
      target: { kind: 'task', template: { prompt: 'recover cursor fence' } },
    });
    const intent = firstSchedules.dispatches.begin(
      schedule,
      at(22, 9),
      'ok',
      at(23, 9),
      null,
    );
    secondSchedules.setNextFire(secondSchedules.findById(schedule.id)!, at(24, 9));

    let calls = 0;
    const recovering = new SchedulerService(firstSchedules, {
      enqueue() {
        calls += 1;
        throw new Error('recovery target failed');
      },
    } as unknown as TasksService);
    schedulers.push(recovering);
    recovering.clock = { now: () => at(22, 10) };
    recovering.onModuleInit();
    recovering.onApplicationBootstrap();
    await Promise.resolve();

    expect(calls).toBe(1);
    expect(firstDatabase.db.prepare<{ status: string }, [string]>(
      'SELECT status FROM schedule_dispatch_intents WHERE id = ?',
    ).get(intent.id)?.status).toBe('error');
    expect(secondSchedules.findById(schedule.id)).toMatchObject({
      generation: 0,
      nextFireAt: at(24, 9),
      lastFireAt: at(22, 9),
      lastResult: 'ok',
    });
  });
});
