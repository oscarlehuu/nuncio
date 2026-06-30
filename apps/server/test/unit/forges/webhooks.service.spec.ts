import { Test, TestingModule } from '@nestjs/testing';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseModule } from '../../../src/db/database.module';
import { DatabaseService } from '../../../src/db/database.service';
import { WebhooksService } from '../../../src/forges/webhooks/webhooks.service';
import type { CreateSessionDto } from '../../../src/sessions/domain/sessions.types';
import type { ForgeWebhookEvent } from '../../../src/forges/forges.types';

const KNOWN_PATH = '/projects/nuncio';

function makeEvent(overrides: Partial<ForgeWebhookEvent> = {}): ForgeWebhookEvent {
  return {
    provider: 'github',
    deliveryId: 'delivery-1',
    kind: 'issue',
    action: 'opened',
    owner: 'octo',
    repo: 'nuncio',
    repoFullName: 'octo/nuncio',
    defaultBranch: 'main',
    number: 7,
    title: 'Implement the rate limiter',
    body: 'Throttle requests please',
    labels: ['nuncio'],
    ...overrides,
  };
}

describe('WebhooksService (Phase 4)', () => {
  let module: TestingModule;
  let db: DatabaseService;
  let service: WebhooksService;
  let dataDir: string;

  let createCalls: CreateSessionDto[];
  let sessionsStub: { create: (dto: CreateSessionDto) => Promise<{ id: string }> };
  let gitStub: {
    listProjects: () => Promise<Array<{ path: string }>>;
    remoteInfo: (path: string) => Promise<{ host: string; owner: string; repo: string }>;
  };

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-webhooks-service-'));
    process.env.NUNCIO_DATA_DIR = dataDir;

    module = await Test.createTestingModule({
      imports: [DatabaseModule],
    }).compile();

    db = module.get(DatabaseService);
  });

  afterAll(async () => {
    await module.close();
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.NUNCIO_DATA_DIR;
  });

  beforeEach(() => {
    db.db.exec('DELETE FROM forge_webhook_deliveries');
    createCalls = [];
    sessionsStub = {
      create: async (dto) => {
        createCalls.push(dto);
        return { id: 'sess-123' };
      },
    };
    gitStub = {
      listProjects: async () => [{ path: KNOWN_PATH }],
      remoteInfo: async (path) =>
        path === KNOWN_PATH
          ? { host: 'github.com', owner: 'octo', repo: 'nuncio' }
          : { host: 'github.com', owner: 'someone', repo: 'else' },
    };
    service = new WebhooksService(sessionsStub as never, gitStub as never, db);
  });

  it('creates a session for a labeled issue.opened on a known repo', async () => {
    const result = await service.handleEvent('github', makeEvent());

    expect(result.created).toBe(true);
    expect(result.sessionId).toBe('sess-123');
    expect(createCalls).toHaveLength(1);
    const dto = createCalls[0];
    expect(dto.prompt).toContain('Implement the rate limiter');
    expect(dto.prompt).toContain('Throttle requests please');
    expect(dto.projectPath).toBe(KNOWN_PATH);
    expect(dto.baseBranch).toBe('main');
    expect(dto.useWorktree).toBe(true);
  });

  it('ignores an unknown repo (no local match) without creating a session', async () => {
    const result = await service.handleEvent(
      'github',
      makeEvent({ owner: 'someone', repo: 'else', repoFullName: 'someone/else' }),
    );

    expect(result).toEqual({ created: false, reason: 'unknown-repo' });
    expect(createCalls).toHaveLength(0);
  });

  it('ignores an issue missing the nuncio label', async () => {
    const result = await service.handleEvent('github', makeEvent({ labels: ['enhancement'] }));

    expect(result).toEqual({ created: false, reason: 'no-label' });
    expect(createCalls).toHaveLength(0);
  });

  it('ignores a non-opened action', async () => {
    const result = await service.handleEvent('github', makeEvent({ action: 'closed' }));

    expect(result).toEqual({ created: false, reason: 'ignored-action' });
    expect(createCalls).toHaveLength(0);
  });

  it('ignores pull_request events (v1: issues only)', async () => {
    const result = await service.handleEvent('github', makeEvent({ kind: 'pull_request' }));

    expect(result).toEqual({ created: false, reason: 'ignored-kind' });
    expect(createCalls).toHaveLength(0);
  });

  it('dedupes a replayed delivery: second call is duplicate and only one session is created', async () => {
    const first = await service.handleEvent('github', makeEvent({ deliveryId: 'dup-1' }));
    const second = await service.handleEvent('github', makeEvent({ deliveryId: 'dup-1' }));

    expect(first.created).toBe(true);
    expect(second).toEqual({ created: false, reason: 'duplicate' });
    expect(createCalls).toHaveLength(1);
  });
});
