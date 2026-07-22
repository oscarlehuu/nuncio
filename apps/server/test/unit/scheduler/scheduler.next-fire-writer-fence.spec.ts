import 'reflect-metadata';
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseService } from '../../../src/db/database.service';
import { SchedulerService } from '../../../src/scheduler/scheduler.service';
import { SchedulesRepository } from '../../../src/scheduler/schedules.repository';
import type { TasksService } from '../../../src/tasks/tasks.service';

function at(day: number, hour: number, minute = 0): number {
  return new Date(2026, 6, day, hour, minute, 0, 0).getTime();
}

describe('Scheduler next-fire writer fencing', () => {
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

  function openPair(firstTasks?: TasksService): {
    first: SchedulerService;
    firstSchedules: SchedulesRepository;
    firstDatabase: DatabaseService;
    second: SchedulerService;
    secondSchedules: SchedulesRepository;
  } {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-scheduler-writer-fence-'));
    process.env.NUNCIO_DATA_DIR = dataDir;
    const firstDatabase = new DatabaseService();
    const secondDatabase = new DatabaseService();
    databases.push(firstDatabase, secondDatabase);
    const firstSchedules = new SchedulesRepository(firstDatabase);
    const secondSchedules = new SchedulesRepository(secondDatabase);
    const first = new SchedulerService(firstSchedules, firstTasks);
    const second = new SchedulerService(secondSchedules);
    schedulers.push(first, second);
    return { first, firstSchedules, firstDatabase, second, secondSchedules };
  }

  it('does not let stale rehydration overwrite a concurrent spec and cursor edit', () => {
    const { first, firstSchedules, firstDatabase, second, secondSchedules } = openPair();
    first.clock = second.clock = { now: () => at(22, 8) };
    const schedule = first.create({
      kind: 'cron',
      spec: 'daily@09:00',
      target: { kind: 'task', template: { prompt: 'rehydrate fence' } },
    });
    firstDatabase.db.prepare('UPDATE schedules SET next_fire_at = ? WHERE id = ?')
      .run(at(19, 9), schedule.id);

    const list = firstSchedules.list.bind(firstSchedules);
    const replacementSpec = JSON.stringify({ event: 'issue.opened', label: '工具' });
    firstSchedules.list = () => {
      const stale = list();
      second.updateSpec(schedule.id, 'event', replacementSpec);
      return stale;
    };

    first.rehydrate();

    expect(secondSchedules.findById(schedule.id)).toMatchObject({
      generation: 1,
      kind: 'event',
      spec: replacementSpec,
      nextFireAt: null,
    });
    expect(first.drainStaleSkips()).toEqual([]);
  });

  it('does not let a stale skipped-overlap write replace a concurrent edit', () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const tasks = { enqueue: () => gate } as unknown as TasksService;
    const { first, firstSchedules, firstDatabase, second, secondSchedules } = openPair(tasks);
    let now = at(22, 8);
    first.clock = second.clock = { now: () => now };
    const schedule = first.create({
      kind: 'cron',
      spec: 'daily@09:00',
      target: { kind: 'task', template: { prompt: 'overlap fence' } },
    });

    now = at(22, 9);
    first.scanDue();
    firstDatabase.db.prepare('UPDATE schedules SET next_fire_at = ? WHERE id = ?')
      .run(at(22, 9, 30), schedule.id);

    const listDue = firstSchedules.listDue.bind(firstSchedules);
    let revisedNextFireAt: number | null = null;
    firstSchedules.listDue = (scanNow) => {
      const stale = listDue(scanNow);
      second.updateSpec(schedule.id, 'cron', 'daily@17:00');
      revisedNextFireAt = secondSchedules.findById(schedule.id)?.nextFireAt ?? null;
      return stale;
    };
    now = at(22, 9, 30);

    first.scanDue();

    expect(secondSchedules.findById(schedule.id)).toMatchObject({
      generation: 1,
      spec: 'daily@17:00',
      nextFireAt: revisedNextFireAt,
      lastFireAt: at(22, 9),
      lastResult: 'ok',
    });
    first.onModuleDestroy();
    release();
  });

  it('retries enablement against the latest spec instead of writing an A-derived cursor', () => {
    const { first, firstSchedules, second, secondSchedules } = openPair();
    first.clock = second.clock = { now: () => at(22, 8) };
    const schedule = first.create({
      kind: 'cron',
      spec: 'daily@09:00',
      target: { kind: 'task', template: { prompt: 'enable fence' } },
    });

    const findById = firstSchedules.findById.bind(firstSchedules);
    let intercepted = false;
    firstSchedules.findById = (id) => {
      const stale = findById(id);
      if (!intercepted) {
        intercepted = true;
        second.updateSpec(id, 'cron', 'daily@17:00');
      }
      return stale;
    };

    first.setEnabled(schedule.id, true);

    expect(secondSchedules.findById(schedule.id)).toMatchObject({
      generation: 2,
      enabled: true,
      spec: 'daily@17:00',
      nextFireAt: at(22, 17),
    });
  });

  it('retries a spec edit against latest enabled state instead of reviving its cursor', () => {
    const { first, firstSchedules, second, secondSchedules } = openPair();
    first.clock = second.clock = { now: () => at(22, 8) };
    const schedule = first.create({
      kind: 'cron',
      spec: 'daily@09:00',
      target: { kind: 'task', template: { prompt: 'spec fence' } },
    });

    const findById = firstSchedules.findById.bind(firstSchedules);
    let intercepted = false;
    firstSchedules.findById = (id) => {
      const stale = findById(id);
      if (!intercepted) {
        intercepted = true;
        second.setEnabled(id, false);
      }
      return stale;
    };

    first.updateSpec(schedule.id, 'cron', 'daily@18:00');

    expect(secondSchedules.findById(schedule.id)).toMatchObject({
      generation: 2,
      enabled: false,
      spec: 'daily@18:00',
      nextFireAt: null,
    });
  });
});
