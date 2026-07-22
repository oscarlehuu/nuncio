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
import { at, intentStatus } from './scheduler-dispatch-test-target';

type ScheduleMutation = (
  scheduler: SchedulerService,
  scheduleId: string,
) => void;

describe('Scheduler pending-intent recovery fence', () => {
  let dataDir = '';
  let openDatabase: DatabaseService | null = null;

  afterEach(() => {
    if (openDatabase && !openDatabase.closed) openDatabase.onModuleDestroy();
    openDatabase = null;
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
    dataDir = '';
    delete process.env.NUNCIO_DATA_DIR;
  });

  it('tombstones a receipt-less intent when its schedule was disabled before restart', async () => {
    await expectStaleIntentNotReplayed((scheduler, scheduleId) => {
      scheduler.setEnabled(scheduleId, false);
    });

    const replayed = await recoverPendingIntent();
    expect(replayed.calls).toBe(0);
    expect(replayed.status).toBe('tombstoned');
    replayed.close();
  });

  it('tombstones a receipt-less intent when its schedule was edited before restart', async () => {
    await expectStaleIntentNotReplayed((scheduler, scheduleId) => {
      scheduler.updateSpec(scheduleId, 'cron', 'daily@17:00');
    });
  });

  it('tombstones a receipt-less intent when its schedule was deleted before restart', async () => {
    await expectStaleIntentNotReplayed((scheduler, scheduleId) => {
      scheduler.deleteSchedule(scheduleId);
    });
  });

  it('settles an existing target receipt even when its schedule was deleted', async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-scheduler-recovery-receipt-'));
    process.env.NUNCIO_DATA_DIR = dataDir;
    const database = new DatabaseService();
    const schedules = new SchedulesRepository(database);
    const tasks = new TasksRepository(database);
    const scheduler = new SchedulerService(schedules);
    scheduler.clock = { now: () => at(8, 0) };
    const schedule = scheduler.create({
      kind: 'cron',
      spec: 'daily@09:00',
      target: { kind: 'task', template: { prompt: 'receipt is authoritative' } },
    });
    const intent = schedules.dispatches.begin(schedule, at(9, 0), 'ok', at(17, 0), null);
    schedules.dispatches.withTargetCreation(intent.id, () =>
      tasks.create({ prompt: 'receipt is authoritative' }),
    );
    scheduler.deleteSchedule(schedule.id);
    scheduler.onModuleDestroy();
    database.onModuleDestroy();

    const recovered = await recoverPendingIntent();

    expect(recovered.calls).toBe(0);
    expect(recovered.status).toBe('completed');
    recovered.close();
  });

  it('recovers an unchanged enabled receipt-less intent exactly once', async () => {
    seedPendingIntent();

    const recovered = await recoverPendingIntent();

    expect(recovered.calls).toBe(1);
    expect(recovered.status).toBe('completed');
    recovered.close();

    const replayed = await recoverPendingIntent();
    expect(replayed.calls).toBe(0);
    expect(replayed.status).toBe('completed');
    replayed.close();
  });

  async function expectStaleIntentNotReplayed(mutate: ScheduleMutation): Promise<void> {
    seedPendingIntent(mutate);

    const recovered = await recoverPendingIntent();

    expect(recovered.calls).toBe(0);
    expect(recovered.status).toBe('tombstoned');
    recovered.close();
  }

  function seedPendingIntent(mutate?: ScheduleMutation): void {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-scheduler-recovery-fence-'));
    process.env.NUNCIO_DATA_DIR = dataDir;
    const database = new DatabaseService();
    const schedules = new SchedulesRepository(database);
    const scheduler = new SchedulerService(schedules);
    scheduler.clock = { now: () => at(8, 0) };
    const schedule = scheduler.create({
      kind: 'cron',
      spec: 'daily@09:00',
      target: { kind: 'task', template: { prompt: 'recover only if current' } },
    });
    schedules.dispatches.begin(schedule, at(9, 0), 'ok', at(17, 0), null);
    mutate?.(scheduler, schedule.id);
    scheduler.onModuleDestroy();
    database.onModuleDestroy();
  }

  async function recoverPendingIntent(): Promise<{
    calls: number;
    status: string | null;
    close: () => void;
  }> {
    const database = new DatabaseService();
    openDatabase = database;
    const schedules = new SchedulesRepository(database);
    const target = {
      calls: 0,
      enqueue() {
        this.calls += 1;
        return { id: `task-${this.calls}` };
      },
    };
    const scheduler = new SchedulerService(schedules, target as unknown as TasksService);
    scheduler.clock = { now: () => at(9, 0) };
    scheduler.onModuleInit();
    scheduler.onApplicationBootstrap();
    await Promise.resolve();
    return {
      calls: target.calls,
      status: intentStatus(database),
      close: () => {
        scheduler.onModuleDestroy();
        database.onModuleDestroy();
        if (openDatabase === database) openDatabase = null;
      },
    };
  }
});
