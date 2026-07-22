import 'reflect-metadata';
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseService } from '../../../src/db/database.service';
import { SchedulerService } from '../../../src/scheduler/scheduler.service';
import { SchedulesRepository } from '../../../src/scheduler/schedules.repository';
import { TasksRepository } from '../../../src/tasks/tasks.repository';
import type { CreateTaskDto, TaskDto } from '../../../src/tasks/tasks.types';
import type { TasksService } from '../../../src/tasks/tasks.service';
import type { ForgeWebhookEvent } from '../../../src/forges/forges.types';

const waitFor = async (predicate: () => boolean, timeoutMs = 1_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for scheduler drain');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

function webhook(deliveryId: string): ForgeWebhookEvent {
  return {
    provider: 'github',
    deliveryId,
    kind: 'issue',
    action: 'opened',
    owner: 'o',
    repo: 'r',
    repoFullName: 'o/r',
    defaultBranch: 'main',
    number: 1,
    title: deliveryId,
    body: '',
    labels: [],
  };
}

class PersistingTarget {
  readonly intentOrder: string[] = [];
  private callCount = 0;

  constructor(
    private readonly database: DatabaseService,
    private readonly tasks: TasksRepository,
    private readonly firstResult: Promise<void> | Error | null = null,
  ) {}

  enqueue(input: CreateTaskDto): TaskDto | Promise<TaskDto> {
    this.callCount += 1;
    const intentId = this.database.currentScheduleDispatchIntentId;
    if (!intentId) throw new Error('missing durable intent context');
    this.intentOrder.push(intentId);
    const firstResult = this.firstResult;
    if (this.callCount === 1 && firstResult instanceof Error) throw firstResult;
    const task = this.tasks.create(input);
    return this.callCount === 1 && firstResult && !(firstResult instanceof Error)
      ? firstResult.then(() => task)
      : task;
  }
}

describe('SchedulerService serialized per-schedule intent drain', () => {
  let dataDir = '';
  let database: DatabaseService | null = null;
  let scheduler: SchedulerService | null = null;

  afterEach(() => {
    scheduler?.onModuleDestroy();
    scheduler = null;
    if (database && !database.closed) database.onModuleDestroy();
    database = null;
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
    dataDir = '';
    delete process.env.NUNCIO_DATA_DIR;
  });

  it('drains concurrent same-schedule intents oldest-first after the in-flight target settles', async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-scheduler-serialized-'));
    process.env.NUNCIO_DATA_DIR = dataDir;
    database = new DatabaseService();
    const schedules = new SchedulesRepository(database);
    const tasks = new TasksRepository(database);
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const target = new PersistingTarget(database, tasks, firstGate);
    scheduler = new SchedulerService(schedules, target as unknown as TasksService);
    scheduler.create({
      kind: 'event',
      spec: JSON.stringify({ event: 'issue.opened' }),
      target: { kind: 'task', template: { prompt: 'serialized target' } },
    });

    scheduler.handleWebhookEvent('github', webhook('one'));
    scheduler.handleWebhookEvent('github', webhook('two'));
    scheduler.handleWebhookEvent('github', webhook('three'));

    const pendingIds = schedules.dispatches.listPending().map((intent) => intent.id);
    expect(pendingIds).toHaveLength(3);
    expect(target.intentOrder).toEqual([pendingIds[0]]);

    releaseFirst();
    await waitFor(() => schedules.dispatches.listPending().length === 0);

    expect(target.intentOrder).toEqual(pendingIds);
    const receipts = database.db.prepare<{ schedule_dispatch_intent_id: string }, []>(
      `SELECT schedule_dispatch_intent_id FROM tasks
       WHERE schedule_dispatch_intent_id IS NOT NULL ORDER BY created_at, rowid`,
    ).all().map((row) => row.schedule_dispatch_intent_id);
    expect(receipts).toEqual(pendingIds);
    expect(new Set(receipts).size).toBe(3);
  });

  it('settles a failed dispatch and continues with the next oldest intent', async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-scheduler-failed-next-'));
    process.env.NUNCIO_DATA_DIR = dataDir;
    database = new DatabaseService();
    const schedules = new SchedulesRepository(database);
    const tasks = new TasksRepository(database);
    const target = new PersistingTarget(database, tasks, new Error('first target failed'));
    scheduler = new SchedulerService(schedules, target as unknown as TasksService);
    const schedule = scheduler.create({
      kind: 'event',
      spec: JSON.stringify({ event: 'issue.opened' }),
      target: { kind: 'task', template: { prompt: 'continue after failure' } },
    });

    const first = schedules.dispatches.begin(schedule, 1, 'ok', null, null);
    const second = schedules.dispatches.begin(schedule, 2, 'ok', null, null);
    scheduler.onApplicationBootstrap();

    await waitFor(() => schedules.dispatches.listPending().length === 0);

    const statuses = database.db.prepare<{ id: string; status: string }, []>(
      'SELECT id, status FROM schedule_dispatch_intents ORDER BY created_at, rowid',
    ).all();
    expect(statuses).toEqual([
      { id: first.id, status: 'error' },
      { id: second.id, status: 'completed' },
    ]);
    expect(target.intentOrder).toEqual([first.id, second.id]);
    expect(tasks.list().filter((task) => task.prompt === 'continue after failure')).toHaveLength(1);
  });

  it('retries a transient settlement failure without duplicating the target or blocking the backlog', async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-scheduler-settle-retry-'));
    process.env.NUNCIO_DATA_DIR = dataDir;
    database = new DatabaseService();
    const schedules = new SchedulesRepository(database);
    const tasks = new TasksRepository(database);
    const target = new PersistingTarget(database, tasks);
    scheduler = new SchedulerService(schedules, target as unknown as TasksService);
    const schedule = scheduler.create({
      kind: 'event',
      spec: JSON.stringify({ event: 'issue.opened' }),
      target: { kind: 'task', template: { prompt: 'settlement retry' } },
    });
    const first = schedules.dispatches.begin(schedule, 1, 'ok', null, null);
    const second = schedules.dispatches.begin(schedule, 2, 'ok', null, null);
    const settle = schedules.dispatches.settle.bind(schedules.dispatches);
    let failOnce = true;
    schedules.dispatches.settle = (intent, result) => {
      if (failOnce) {
        failOnce = false;
        throw new Error('settlement temporarily unavailable');
      }
      return settle(intent, result);
    };

    scheduler.onApplicationBootstrap();
    await waitFor(() => schedules.dispatches.listPending().length === 0);

    expect(target.intentOrder).toEqual([first.id, second.id]);
    expect(tasks.list().filter((task) => task.prompt === 'settlement retry')).toHaveLength(2);
  });

  it('uses the same serialized oldest-first drain for a restart backlog', async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-scheduler-restart-backlog-'));
    process.env.NUNCIO_DATA_DIR = dataDir;

    const seedDatabase = new DatabaseService();
    const seedSchedules = new SchedulesRepository(seedDatabase);
    const seedScheduler = new SchedulerService(seedSchedules);
    const schedule = seedScheduler.create({
      kind: 'event',
      spec: JSON.stringify({ event: 'issue.opened' }),
      target: { kind: 'task', template: { prompt: 'restart backlog' } },
    });
    const expected = [
      seedSchedules.dispatches.begin(schedule, 1, 'ok', null, null).id,
      seedSchedules.dispatches.begin(schedule, 2, 'ok', null, null).id,
      seedSchedules.dispatches.begin(schedule, 3, 'ok', null, null).id,
    ];
    seedScheduler.onModuleDestroy();
    seedDatabase.onModuleDestroy();

    database = new DatabaseService();
    const recoveredSchedules = new SchedulesRepository(database);
    const tasks = new TasksRepository(database);
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const target = new PersistingTarget(database, tasks, firstGate);
    scheduler = new SchedulerService(recoveredSchedules, target as unknown as TasksService);
    scheduler.onModuleInit();
    scheduler.onApplicationBootstrap();

    expect(target.intentOrder).toEqual([expected[0]]);
    releaseFirst();
    await waitFor(() => recoveredSchedules.dispatches.listPending().length === 0);

    expect(target.intentOrder).toEqual(expected);
    expect(tasks.list().filter((task) => task.prompt === 'restart backlog')).toHaveLength(3);
  });
});
