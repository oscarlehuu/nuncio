import 'reflect-metadata';
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseService } from '../../../src/db/database.service';
import { LoopsRepository } from '../../../src/loops/loops.repository';
import { LoopsService } from '../../../src/loops/loops.service';
import { SchedulerService } from '../../../src/scheduler/scheduler.service';
import { SchedulesRepository } from '../../../src/scheduler/schedules.repository';
import { TasksRepository } from '../../../src/tasks/tasks.repository';
import type { TasksService } from '../../../src/tasks/tasks.service';
import { at, intentStatus, PersistingTaskTarget } from './scheduler-dispatch-test-target';

describe('Scheduler loop-target dispatch idempotency', () => {
  let dataDir = '';
  let openDatabase: DatabaseService | null = null;

  afterEach(() => {
    if (openDatabase && !openDatabase.closed) openDatabase.onModuleDestroy();
    openDatabase = null;
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
    dataDir = '';
    delete process.env.NUNCIO_DATA_DIR;
  });

  it('reuses the task/run pair after a crash before intent settlement', async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-scheduler-loop-receipt-'));
    process.env.NUNCIO_DATA_DIR = dataDir;

    const firstDatabase = new DatabaseService();
    openDatabase = firstDatabase;
    const firstSchedules = new SchedulesRepository(firstDatabase);
    const firstTasks = new TasksRepository(firstDatabase);
    const firstTarget = new PersistingTaskTarget(firstDatabase, firstTasks);
    const firstScheduler = new SchedulerService(
      firstSchedules,
      firstTarget as unknown as TasksService,
    );
    const firstLoops = new LoopsRepository(firstDatabase);
    const firstLoopService = new LoopsService(
      firstLoops,
      firstDatabase,
      firstScheduler,
      firstTarget as unknown as TasksService,
    );
    let now = at(8, 0);
    firstScheduler.clock = { now: () => now };
    firstLoopService.clock = { now: () => now };
    firstLoopService.onModuleInit();

    const loop = firstLoops.create({
      goal: 'durable loop target',
      scheduleId: 'pending',
      maxRunsPerDay: 3,
      maxConsecutiveFailures: 3,
      stopJson: null,
      escalation: 'needs-attention',
      projectPath: '/tmp/project',
    });
    const schedule = firstScheduler.create({
      kind: 'cron', spec: 'daily@09:00', target: { kind: 'loop', loopId: loop.id },
    });
    firstLoops.setScheduleId(loop.id, schedule.id);

    now = at(9, 0);
    firstScheduler.scanDue();
    expect(firstTasks.list()).toHaveLength(1);
    expect(firstLoops.listRuns(loop.id)).toHaveLength(1);
    expect(intentStatus(firstDatabase)).toBe('pending');
    firstScheduler.onModuleDestroy();
    firstDatabase.onModuleDestroy();
    openDatabase = null;
    await Promise.resolve();

    const secondDatabase = new DatabaseService();
    openDatabase = secondDatabase;
    const secondSchedules = new SchedulesRepository(secondDatabase);
    const secondTasks = new TasksRepository(secondDatabase);
    const secondTarget = new PersistingTaskTarget(secondDatabase, secondTasks);
    const secondScheduler = new SchedulerService(
      secondSchedules,
      secondTarget as unknown as TasksService,
    );
    const secondLoops = new LoopsRepository(secondDatabase);
    const secondLoopService = new LoopsService(
      secondLoops,
      secondDatabase,
      secondScheduler,
      secondTarget as unknown as TasksService,
    );
    secondScheduler.clock = { now: () => now };
    secondLoopService.clock = { now: () => now };
    secondScheduler.onModuleInit();
    secondLoopService.onModuleInit();
    secondScheduler.onApplicationBootstrap();
    await Promise.resolve();

    expect(secondTasks.list()).toHaveLength(1);
    expect(secondLoops.listRuns(loop.id)).toHaveLength(1);
    expect(intentStatus(secondDatabase)).toBe('completed');
    secondScheduler.onModuleDestroy();
  });
});
