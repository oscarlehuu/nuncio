import 'reflect-metadata';
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseService } from '../../../src/db/database.service';
import { WebhookDeliveryTracker } from '../../../src/forges/webhooks/webhook-delivery-tracker';
import { WebhooksService } from '../../../src/forges/webhooks/webhooks.service';
import type { ForgeWebhookEvent } from '../../../src/forges/forges.types';
import { LoopsRepository } from '../../../src/loops/loops.repository';
import { LoopsService } from '../../../src/loops/loops.service';
import { SchedulerService } from '../../../src/scheduler/scheduler.service';
import { SchedulesRepository } from '../../../src/scheduler/schedules.repository';
import { TasksRepository } from '../../../src/tasks/tasks.repository';
import type { TasksService } from '../../../src/tasks/tasks.service';
import { PersistingTaskTarget } from '../scheduler/scheduler-dispatch-test-target';

const PROJECT_PATH = '/repos/nuncio';
const LOOP_LABEL = 'run-loop';

type GitStub = {
  listProjects: () => Promise<Array<{ path: string }>>;
  remoteInfo: () => Promise<{ host: string; owner: string; repo: string }>;
};

interface Harness {
  database: DatabaseService;
  webhooks: WebhooksService;
  scheduler: SchedulerService;
  loops: LoopsRepository;
  tasks: TasksRepository;
  git: GitStub;
  close(): void;
}

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
    title: 'Run the loop',
    body: '',
    labels: [LOOP_LABEL],
  };
}

function openHarness(dataDir: string): Harness {
  process.env.NUNCIO_DATA_DIR = dataDir;
  const database = new DatabaseService();
  const schedules = new SchedulesRepository(database);
  const tasks = new TasksRepository(database);
  const target = new PersistingTaskTarget(database, tasks);
  const scheduler = new SchedulerService(schedules, target as unknown as TasksService);
  const loops = new LoopsRepository(database);
  const loopService = new LoopsService(
    loops,
    database,
    scheduler,
    target as unknown as TasksService,
  );
  scheduler.onModuleInit();
  loopService.onModuleInit();
  scheduler.onApplicationBootstrap();

  const git: GitStub = {
    listProjects: async () => [{ path: PROJECT_PATH }],
    remoteInfo: async () => ({ host: 'github.com', owner: 'octo', repo: 'nuncio' }),
  };
  const sessions = {
    onBackgroundSteerFailure: () => () => {},
    onBackgroundSteerDelivered: () => () => {},
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
    webhooks,
    scheduler,
    loops,
    tasks,
    git,
    close: () => {
      webhooks.onModuleDestroy();
      scheduler.onModuleDestroy();
      database.onModuleDestroy();
    },
  };
}

function seedEventLoop(harness: Harness): string {
  const loop = harness.loops.create({
    goal: 'Handle matching issues',
    scheduleId: 'pending',
    maxRunsPerDay: 10,
    maxConsecutiveFailures: 3,
    stopJson: null,
    escalation: 'needs-attention',
    projectPath: PROJECT_PATH,
  });
  const schedule = harness.scheduler.create({
    kind: 'event',
    spec: JSON.stringify({
      event: 'issue.opened',
      label: LOOP_LABEL,
      projectPath: PROJECT_PATH,
    }),
    target: { kind: 'loop', loopId: loop.id },
  });
  harness.loops.setScheduleId(loop.id, schedule.id);
  return loop.id;
}

function deliveryTracker(webhooks: WebhooksService): WebhookDeliveryTracker {
  return (webhooks as unknown as { deliveries: WebhookDeliveryTracker }).deliveries;
}

function failDispatchIntentInserts(database: DatabaseService): void {
  database.db.exec(`
    CREATE TRIGGER fail_schedule_dispatch_intent
    BEFORE INSERT ON schedule_dispatch_intents
    BEGIN
      SELECT RAISE(ABORT, 'simulated intent persistence failure');
    END
  `);
}

function deliveryStatus(database: DatabaseService, deliveryId: string): string | null {
  return database.db.prepare<{ status: string }, [string]>(
    'SELECT status FROM forge_webhook_deliveries WHERE delivery_id = ?',
  ).get(`${deliveryId}#loops`)?.status ?? null;
}

function dispatchIntentCount(database: DatabaseService): number {
  return database.db.prepare<{ count: number }, []>(
    'SELECT COUNT(*) AS count FROM schedule_dispatch_intents',
  ).get()?.count ?? 0;
}

describe('webhook event-loop target idempotency', () => {
  let dataDir = '';
  let open: Harness | null = null;

  afterEach(() => {
    open?.close();
    open = null;
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
    dataDir = '';
    delete process.env.NUNCIO_DATA_DIR;
  });

  it('completes a delivery with no matching event schedule without creating an intent', async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-webhook-loop-no-match-'));
    open = openHarness(dataDir);

    await open.webhooks.handleEvent('github', issue('no-matching-schedule'));

    expect(deliveryStatus(open.database, 'no-matching-schedule')).toBe('completed');
    expect(dispatchIntentCount(open.database)).toBe(0);
    expect(open.tasks.list()).toHaveLength(0);
  });

  it('keeps delivery retryable when scheduler intent persistence fails inside acceptance', async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-webhook-loop-intent-failure-'));
    open = openHarness(dataDir);
    seedEventLoop(open);
    failDispatchIntentInserts(open.database);

    await open.webhooks.handleEvent('github', issue('intent-failure-delivery'));
    await Promise.resolve();

    expect(deliveryStatus(open.database, 'intent-failure-delivery')).toBe('retryable');
    expect(dispatchIntentCount(open.database)).toBe(0);
    expect(open.tasks.list()).toHaveLength(0);
  });

  it('retries the same delivery once intent persistence recovers without duplicating targets', async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-webhook-loop-intent-retry-'));
    open = openHarness(dataDir);
    const loopId = seedEventLoop(open);
    failDispatchIntentInserts(open.database);
    const event = issue('intent-retry-delivery');

    await open.webhooks.handleEvent('github', event);
    expect(deliveryStatus(open.database, 'intent-retry-delivery')).toBe('retryable');
    expect(dispatchIntentCount(open.database)).toBe(0);

    open.database.db.exec('DROP TRIGGER fail_schedule_dispatch_intent');
    await open.webhooks.handleEvent('github', event);
    await Promise.resolve();
    await open.webhooks.handleEvent('github', event);
    await Promise.resolve();

    expect(deliveryStatus(open.database, 'intent-retry-delivery')).toBe('completed');
    expect(dispatchIntentCount(open.database)).toBe(1);
    expect(open.tasks.list()).toHaveLength(1);
    expect(open.loops.listRuns(loopId)).toHaveLength(1);
  });

  it('reclaims after restart without creating a second task/run pair', async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-webhook-loop-restart-'));
    const first = openHarness(dataDir);
    open = first;
    const loopId = seedEventLoop(first);
    const tracker = deliveryTracker(first.webhooks);
    tracker.complete = (<T>(claim: Parameters<WebhookDeliveryTracker['complete']>[0], work: () => T) =>
      first.database.immediateTransaction(() => {
        tracker.assertOwned(claim);
        work();
        throw new Error('simulated daemon crash before webhook acceptance');
      })) as WebhookDeliveryTracker['complete'];
    tracker.release = () => {};

    await first.webhooks.handleEvent('github', issue('restart-delivery'));
    first.close();
    open = null;

    const second = openHarness(dataDir);
    open = second;
    for (const run of second.loops.listRuns(loopId)) {
      if (run.taskId) {
        second.database.db.prepare(
          "UPDATE tasks SET status = 'DONE', finished_at = ?, updated_at = ? WHERE id = ?",
        ).run(Date.now(), Date.now(), run.taskId);
        second.loops.updateRunOutcome(run.id, 'ok', 'green');
      }
    }
    second.database.db.prepare(
      'UPDATE forge_webhook_deliveries SET lease_expires_at = ? WHERE provider = ? AND delivery_id = ?',
    ).run(0, 'github', 'restart-delivery#loops');

    await second.webhooks.handleEvent('github', issue('restart-delivery'));
    await Promise.resolve();

    expect(second.tasks.list()).toHaveLength(1);
    expect(second.loops.listRuns(loopId)).toHaveLength(1);
    expect(second.database.db.prepare<{ count: number }, []>(
      'SELECT COUNT(*) AS count FROM schedule_dispatch_intents',
    ).get()?.count).toBe(1);
  });

  it('admits one target for concurrent sibling duplicate deliveries', async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-webhook-loop-concurrent-'));
    open = openHarness(dataDir);
    const loopId = seedEventLoop(open);
    let releaseProjects!: () => void;
    open.git.listProjects = () => new Promise((resolve) => {
      releaseProjects = () => resolve([{ path: PROJECT_PATH }]);
    });

    const event = issue('concurrent-delivery');
    const first = open.webhooks.handleEvent('github', event);
    await Promise.resolve();
    const sibling = open.webhooks.handleEvent('github', event);
    releaseProjects();
    await Promise.all([first, sibling]);
    await Promise.resolve();

    expect(open.tasks.list()).toHaveLength(1);
    expect(open.loops.listRuns(loopId)).toHaveLength(1);
    expect(open.database.db.prepare<{ count: number }, []>(
      'SELECT COUNT(*) AS count FROM schedule_dispatch_intents',
    ).get()?.count).toBe(1);
  });
});
