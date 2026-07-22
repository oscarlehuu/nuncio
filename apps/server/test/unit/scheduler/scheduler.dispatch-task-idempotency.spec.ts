import 'reflect-metadata';
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseService } from '../../../src/db/database.service';
import { SchedulerService } from '../../../src/scheduler/scheduler.service';
import { SchedulesRepository } from '../../../src/scheduler/schedules.repository';
import { TasksRepository } from '../../../src/tasks/tasks.repository';
import type { TasksService } from '../../../src/tasks/tasks.service';
import { at, intentStatus, PersistingTaskTarget } from './scheduler-dispatch-test-target';

describe('Scheduler direct-task dispatch idempotency', () => {
  let dataDir = '';
  let openDatabase: DatabaseService | null = null;

  afterEach(() => {
    if (openDatabase && !openDatabase.closed) openDatabase.onModuleDestroy();
    openDatabase = null;
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
    dataDir = '';
    delete process.env.NUNCIO_DATA_DIR;
  });

  it('reuses the task after a crash, settlement failure, and stale schedule edit', async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-scheduler-task-receipt-'));
    process.env.NUNCIO_DATA_DIR = dataDir;

    const firstDatabase = new DatabaseService();
    openDatabase = firstDatabase;
    const firstSchedules = new SchedulesRepository(firstDatabase);
    const firstTasks = new TasksRepository(firstDatabase);
    const firstScheduler = new SchedulerService(
      firstSchedules,
      new PersistingTaskTarget(firstDatabase, firstTasks) as unknown as TasksService,
    );
    let now = at(8, 0);
    firstScheduler.clock = { now: () => now };
    const schedule = firstScheduler.create({
      kind: 'cron', spec: 'daily@09:00',
      target: { kind: 'task', template: { prompt: 'exactly once' } },
    });

    now = at(9, 0);
    firstScheduler.scanDue();
    expect(firstTasks.list().filter((task) => task.prompt === 'exactly once')).toHaveLength(1);
    expect(intentStatus(firstDatabase)).toBe('pending');
    firstScheduler.updateSpec(schedule.id, 'cron', 'daily@17:00');
    const revised = firstSchedules.findById(schedule.id)!;

    // Stop before the promise continuation can settle the already-committed target.
    firstScheduler.onModuleDestroy();
    firstDatabase.onModuleDestroy();
    openDatabase = null;
    await Promise.resolve();

    const secondDatabase = new DatabaseService();
    openDatabase = secondDatabase;
    const secondSchedules = new SchedulesRepository(secondDatabase);
    const secondTasks = new TasksRepository(secondDatabase);
    const secondScheduler = new SchedulerService(
      secondSchedules,
      new PersistingTaskTarget(secondDatabase, secondTasks) as unknown as TasksService,
    );
    secondScheduler.clock = { now: () => now };
    secondSchedules.dispatches.settle = () => { throw new Error('settlement storage unavailable'); };
    secondScheduler.onModuleInit();
    secondScheduler.onApplicationBootstrap();
    await Promise.resolve();

    expect(secondTasks.list().filter((task) => task.prompt === 'exactly once')).toHaveLength(1);
    expect(intentStatus(secondDatabase)).toBe('pending');
    expect(secondSchedules.findById(schedule.id)).toMatchObject({
      generation: 1, kind: 'cron', spec: 'daily@17:00', nextFireAt: revised.nextFireAt,
    });
    secondScheduler.onModuleDestroy();
    secondDatabase.onModuleDestroy();
    openDatabase = null;

    const thirdDatabase = new DatabaseService();
    openDatabase = thirdDatabase;
    const thirdSchedules = new SchedulesRepository(thirdDatabase);
    const thirdTasks = new TasksRepository(thirdDatabase);
    const thirdScheduler = new SchedulerService(
      thirdSchedules,
      new PersistingTaskTarget(thirdDatabase, thirdTasks) as unknown as TasksService,
    );
    thirdScheduler.clock = { now: () => now };
    thirdScheduler.onModuleInit();
    thirdScheduler.onApplicationBootstrap();
    await Promise.resolve();

    expect(thirdTasks.list().filter((task) => task.prompt === 'exactly once')).toHaveLength(1);
    expect(intentStatus(thirdDatabase)).toBe('completed');
    expect(thirdSchedules.findById(schedule.id)).toMatchObject({
      generation: 1, kind: 'cron', spec: 'daily@17:00', nextFireAt: revised.nextFireAt,
    });
    thirdScheduler.onModuleDestroy();
  });

  it('replays once when target creation failed before writing a receipt', async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-scheduler-task-no-receipt-'));
    process.env.NUNCIO_DATA_DIR = dataDir;

    const firstDatabase = new DatabaseService();
    openDatabase = firstDatabase;
    const firstSchedules = new SchedulesRepository(firstDatabase);
    const firstScheduler = new SchedulerService(
      firstSchedules,
      { enqueue: () => { throw new Error('target storage unavailable'); } } as unknown as TasksService,
    );
    let now = at(8, 0);
    firstScheduler.clock = { now: () => now };
    firstScheduler.create({
      kind: 'cron', spec: 'daily@09:00',
      target: { kind: 'task', template: { prompt: 'retry without receipt' } },
    });
    now = at(9, 0);
    firstScheduler.scanDue();
    expect(intentStatus(firstDatabase)).toBe('pending');
    firstScheduler.onModuleDestroy();
    firstDatabase.onModuleDestroy();
    openDatabase = null;
    await Promise.resolve();

    const secondDatabase = new DatabaseService();
    openDatabase = secondDatabase;
    const secondSchedules = new SchedulesRepository(secondDatabase);
    const secondTasks = new TasksRepository(secondDatabase);
    const secondScheduler = new SchedulerService(
      secondSchedules,
      new PersistingTaskTarget(secondDatabase, secondTasks) as unknown as TasksService,
    );
    secondScheduler.clock = { now: () => now };
    secondScheduler.onModuleInit();
    secondScheduler.onApplicationBootstrap();
    await Promise.resolve();

    expect(secondTasks.list().filter((task) => task.prompt === 'retry without receipt')).toHaveLength(1);
    expect(intentStatus(secondDatabase)).toBe('completed');
    secondScheduler.onModuleDestroy();
  });
});
