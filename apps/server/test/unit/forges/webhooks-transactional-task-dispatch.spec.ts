import 'reflect-metadata';
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseService } from '../../../src/db/database.service';
import { WebhookDeliveryTracker } from '../../../src/forges/webhooks/webhook-delivery-tracker';
import { WebhooksService } from '../../../src/forges/webhooks/webhooks.service';
import type { ForgeWebhookEvent } from '../../../src/forges/forges.types';
import { SchedulerService } from '../../../src/scheduler/scheduler.service';
import { SchedulesRepository } from '../../../src/scheduler/schedules.repository';
import { EventsRepository } from '../../../src/sessions/persistence/events.repository';
import { TasksRepository } from '../../../src/tasks/tasks.repository';
import { TasksService } from '../../../src/tasks/tasks.service';

const PROJECT_PATH = '/repos/nuncio';

function issue(deliveryId: string): ForgeWebhookEvent {
  return {
    provider: 'github',
    deliveryId,
    kind: 'issue',
    action: 'opened',
    owner: 'octo',
    repo: 'nuncio',
    repoFullName: 'octo/nuncio',
    defaultBranch: 'main',
    number: 7,
    title: 'Dispatch direct task',
    body: '',
    labels: ['agent'],
  };
}

interface LaunchObservation {
  deliveryStatus: string | null;
  intentStatus: string | null;
}

interface Harness {
  database: DatabaseService;
  tasksRepository: TasksRepository;
  tasksService: TasksService;
  scheduler: SchedulerService;
  webhooks: WebhooksService;
  launches: LaunchObservation[];
  close(): void;
}

function scalarStatus(database: DatabaseService, table: string): string | null {
  return database.db.prepare<{ status: string }, []>(
    `SELECT status FROM ${table} ORDER BY rowid DESC LIMIT 1`,
  ).get()?.status ?? null;
}

function openHarness(dataDir: string, scheduleCount = 1): Harness {
  process.env.NUNCIO_DATA_DIR = dataDir;
  const database = new DatabaseService();
  const tasksRepository = new TasksRepository(database);
  const launches: LaunchObservation[] = [];
  const sessions = {
    onBackgroundSteerFailure: () => () => {},
    onBackgroundSteerDelivered: () => () => {},
    create: () => {
      launches.push({
        deliveryStatus: scalarStatus(database, 'forge_webhook_deliveries'),
        intentStatus: scalarStatus(database, 'schedule_dispatch_intents'),
      });
      return new Promise<never>(() => {});
    },
  };
  const tasksService = new TasksService(
    tasksRepository,
    sessions as never,
    new EventsRepository(database),
    database,
  );
  const scheduler = new SchedulerService(new SchedulesRepository(database), tasksService);
  for (let index = 0; index < scheduleCount; index += 1) {
    scheduler.create({
      kind: 'event',
      spec: JSON.stringify({
        event: 'issue.opened', label: 'agent', projectPath: PROJECT_PATH,
      }),
      target: { kind: 'task', template: { prompt: `Handle webhook issue ${index + 1}` } },
    });
  }
  const git = {
    listProjects: async () => [{ path: PROJECT_PATH }],
    remoteInfo: async () => ({ host: 'github.com', owner: 'octo', repo: 'nuncio' }),
  };
  const webhooks = new (WebhooksService as never as new (...args: never[]) => WebhooksService)(
    sessions as never,
    git as never,
    database as never,
    { findById: () => null, findByProjectPullRequest: () => null } as never,
    { resolve: () => undefined } as never,
    { listStatus: async () => [] } as never,
    {} as never,
    { raise: () => {}, onConditionCleared: () => {} } as never,
    scheduler as never,
  );

  return {
    database,
    tasksRepository,
    tasksService,
    scheduler,
    webhooks,
    launches,
    close: () => {
      webhooks.onModuleDestroy();
      scheduler.onModuleDestroy();
      tasksService.onModuleDestroy();
      database.onModuleDestroy();
    },
  };
}

function deliveryTracker(webhooks: WebhooksService): WebhookDeliveryTracker {
  return (webhooks as unknown as { deliveries: WebhookDeliveryTracker }).deliveries;
}

describe('transactional webhook direct-task dispatch', () => {
  let dataDir = '';
  let harness: Harness | null = null;

  afterEach(() => {
    harness?.close();
    harness = null;
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
    dataDir = '';
    delete process.env.NUNCIO_DATA_DIR;
  });

  it('starts no session when lease-fenced acceptance rolls back the task and intent', async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-webhook-task-rollback-'));
    harness = openHarness(dataDir);
    const tracker = deliveryTracker(harness.webhooks);
    let now = 100;
    tracker.clock = { now: () => now };
    tracker.leaseMs = 10;

    const createMany = harness.tasksRepository.createMany.bind(harness.tasksRepository);
    harness.tasksRepository.createMany = ((inputs) => {
      const tasks = createMany(inputs);
      now = 110; // exact expiry after target persistence, before delivery completion
      return tasks;
    }) as typeof harness.tasksRepository.createMany;

    await harness.webhooks.handleEvent('github', issue('lease-fenced-direct-task'));
    await Promise.resolve();

    expect(harness.launches).toHaveLength(0);
    expect(scalarStatus(harness.database, 'forge_webhook_deliveries')).toBe('retryable');
    expect(harness.database.db.prepare<{ count: number }, []>(
      'SELECT COUNT(*) AS count FROM schedule_dispatch_intents',
    ).get()?.count).toBe(0);
    expect(harness.tasksRepository.list()).toHaveLength(0);
  });

  it('rolls back every matched target before pumping when a later target write fails', async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-webhook-task-multi-rollback-'));
    harness = openHarness(dataDir, 2);
    const createMany = harness.tasksRepository.createMany.bind(harness.tasksRepository);
    let writes = 0;
    harness.tasksRepository.createMany = ((inputs) => {
      const tasks = createMany(inputs);
      writes += 1;
      if (writes === 2) throw new Error('second target persistence failed');
      return tasks;
    }) as typeof harness.tasksRepository.createMany;

    await harness.webhooks.handleEvent('github', issue('multi-target-failure'));
    await Promise.resolve();

    expect(harness.launches).toHaveLength(0);
    expect(scalarStatus(harness.database, 'forge_webhook_deliveries')).toBe('retryable');
    expect(harness.database.db.prepare<{ count: number }, []>(
      'SELECT COUNT(*) AS count FROM schedule_dispatch_intents',
    ).get()?.count).toBe(0);
    expect(harness.tasksRepository.list()).toHaveLength(0);
  });

  it('starts the committed task only after delivery and intent completion are durable', async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-webhook-task-commit-'));
    harness = openHarness(dataDir);

    await harness.webhooks.handleEvent('github', issue('committed-direct-task'));
    await Promise.resolve();

    expect(harness.launches).toEqual([{ deliveryStatus: 'completed', intentStatus: 'completed' }]);
    expect(harness.tasksRepository.list()).toHaveLength(1);
  });
});
