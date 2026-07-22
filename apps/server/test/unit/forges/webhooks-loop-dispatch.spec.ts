import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { Test, TestingModule } from '@nestjs/testing';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseModule } from '../../../src/db/database.module';
import { DatabaseService } from '../../../src/db/database.service';
import { WebhooksService } from '../../../src/forges/webhooks/webhooks.service';
import type { ForgeWebhookEvent } from '../../../src/forges/forges.types';

const KNOWN_PATH = '/repos/nuncio';

function issue(overrides: Partial<Extract<ForgeWebhookEvent, { kind: 'issue' }>> = {}): ForgeWebhookEvent {
  return {
    provider: 'github',
    deliveryId: 'd-1',
    kind: 'issue',
    action: 'opened',
    owner: 'octo',
    repo: 'nuncio',
    repoFullName: 'octo/nuncio',
    defaultBranch: 'main',
    number: 3,
    title: 'Bug',
    body: 'Body',
    labels: ['agent'],
    ...overrides,
  };
}

/** Records scheduler.handleWebhookEvent dispatches (provider, event, projectPath). */
class SchedulerSpy {
  readonly dispatches: Array<{ provider: string; kind: string; projectPath: string | null | undefined }> = [];

  handleWebhookEventTransactional(
    provider: string,
    event: ForgeWebhookEvent,
    projectPath?: string | null,
  ) {
    this.dispatches.push({ provider, kind: event.kind, projectPath });
    return () => {};
  }
}

/**
 * Event-loop dispatch is wired through WebhooksService.handleEvent — every
 * de-duplicated issue/PR delivery reaches the scheduler with its resolved local
 * project, so a project-scoped loop fires only for its own repo (P1 scope) and a
 * replay never double-fires (independent `#loops` dedup keyspace).
 */
describe('WebhooksService → event-loop dispatch', () => {
  let module: TestingModule;
  let db: DatabaseService;
  let dataDir: string;
  let scheduler: SchedulerSpy;
  let service: WebhooksService;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-webhooks-loop-'));
    process.env.NUNCIO_DATA_DIR = dataDir;
    module = await Test.createTestingModule({ imports: [DatabaseModule] }).compile();
    db = module.get(DatabaseService);
  });

  afterAll(async () => {
    await module.close();
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.NUNCIO_DATA_DIR;
  });

  beforeEach(() => {
    db.db.exec('DELETE FROM forge_webhook_deliveries');
    scheduler = new SchedulerSpy();
    const sessionsStub = {
      onBackgroundSteerFailure: () => () => {},
      onBackgroundSteerDelivered: () => () => {},
    };
    const gitStub = {
      listProjects: async () => [{ path: KNOWN_PATH }],
      remoteInfo: async () => ({ host: 'github.com', owner: 'octo', repo: 'nuncio' }),
    };
    const noop = {} as never;
    const settingsStub = { resolve: () => undefined } as never;
    service = new (WebhooksService as never as new (...args: never[]) => WebhooksService)(
      sessionsStub as never,
      gitStub as never,
      db as never,
      { findById: () => null, findByProjectPullRequest: () => null } as never,
      settingsStub,
      { listStatus: async () => [] } as never,
      noop,
      { raise: () => {}, onConditionCleared: () => {} } as never,
      scheduler as never,
    );
  });

  it('dispatches an issue delivery to the scheduler with the resolved project', async () => {
    await service.handleEvent('github', issue());
    expect(scheduler.dispatches).toHaveLength(1);
    expect(scheduler.dispatches[0]).toEqual({
      provider: 'github',
      kind: 'issue',
      projectPath: KNOWN_PATH,
    });
  });

  it('does not re-dispatch a replayed delivery (independent #loops dedup)', async () => {
    await service.handleEvent('github', issue({ deliveryId: 'dup' }));
    await service.handleEvent('github', issue({ deliveryId: 'dup' }));
    expect(scheduler.dispatches).toHaveLength(1);
  });

  it('renews a long loop-dispatch claim so replay cannot dispatch concurrently', async () => {
    let releaseProjects!: () => void;
    const projects = new Promise<Array<{ path: string }>>((resolve) => {
      releaseProjects = () => resolve([{ path: KNOWN_PATH }]);
    });
    (service as unknown as { git: { listProjects: () => Promise<Array<{ path: string }>> } })
      .git.listProjects = () => projects;
    const internals = service as unknown as {
      deliveryHeartbeatMs: number;
      deliveries: { leaseMs: number };
    };
    internals.deliveryHeartbeatMs = 2;
    internals.deliveries.leaseMs = 15;

    const event = issue({ deliveryId: 'long-loop-dispatch', labels: [] });
    const first = service.handleEvent('github', event);
    await Promise.resolve();
    db.db.prepare(
      'UPDATE forge_webhook_deliveries SET lease_expires_at = ? WHERE provider = ? AND delivery_id = ?',
    ).run(Date.now() + 10, 'github', 'long-loop-dispatch#loops');
    await new Promise((resolve) => setTimeout(resolve, 30));
    const replay = service.handleEvent('github', event);
    releaseProjects();

    await Promise.all([first, replay]);
    expect(scheduler.dispatches).toHaveLength(1);
  });

  it('dispatches issue AND pull_request deliveries, ignoring feedback/ci kinds', async () => {
    await service.handleEvent('github', issue({ deliveryId: 'i' }));
    await service.handleEvent('github', {
      provider: 'github',
      deliveryId: 'p',
      kind: 'pull_request',
      action: 'closed',
      owner: 'octo',
      repo: 'nuncio',
      repoFullName: 'octo/nuncio',
      defaultBranch: 'main',
      number: 5,
      title: 'PR',
      body: '',
      labels: [],
      merged: true,
    });
    await service.handleEvent('github', {
      provider: 'github',
      deliveryId: 'c',
      kind: 'ci_failure',
      action: 'failed',
      owner: 'octo',
      repo: 'nuncio',
      repoFullName: 'octo/nuncio',
      defaultBranch: 'main',
      number: 5,
      labels: [],
      jobName: 'unit',
      url: 'https://example.test/run/1',
    });
    expect(scheduler.dispatches.map((d) => d.kind)).toEqual(['issue', 'pull_request']);
  });

  it('dispatches with a null project when the repo has no local clone', async () => {
    // Re-point the resolver at a non-matching remote.
    (service as unknown as { git: { remoteInfo: () => Promise<unknown> } }).git.remoteInfo = async () => ({
      host: 'github.com',
      owner: 'someone',
      repo: 'else',
    });
    await service.handleEvent('github', issue());
    expect(scheduler.dispatches[0]!.projectPath).toBeNull();
  });
});
