import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Test, TestingModule } from '@nestjs/testing';
import { DatabaseModule } from '../../../src/db/database.module';
import { PiLocalSessionsService } from '../../../src/pi-local/pi-local-sessions.service';
import { SessionsPersistenceModule } from '../../../src/sessions/sessions.persistence.module';
import { SessionsRepository } from '../../../src/sessions/persistence/sessions.repository';

describe('PiLocalSessionsService', () => {
  let module: TestingModule;
  let service: PiLocalSessionsService;
  let repo: SessionsRepository;
  let dataDir: string;
  const workspace = '/tmp/demo-repo';
  const piPath = '/Users/me/.pi/agent/sessions/demo/20260701_session.jsonl';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-pi-local-db-'));
    process.env.NUNCIO_DATA_DIR = dataDir;

    module = await Test.createTestingModule({
      imports: [DatabaseModule, SessionsPersistenceModule],
      providers: [PiLocalSessionsService],
    }).compile();

    service = module.get(PiLocalSessionsService);
    repo = module.get(SessionsRepository);
    service.loadSdk = async () => ({
      SessionManager: {
        list: async (cwd: string) => {
          expect(cwd).toBe(workspace);
          return [
            {
              id: 'pi-session-id',
              path: piPath,
              cwd: workspace,
              name: 'Named pi task',
              firstMessage: 'Please continue this pi task',
              messageCount: 3,
              modified: new Date('2026-07-01T12:00:00Z'),
              created: new Date('2026-07-01T11:00:00Z'),
              allMessagesText: 'Please continue this pi task\nAssistant preview',
            },
          ];
        },
      },
    } as never);
    service.openSession = (path: string) => ({
      getEntries: () => [
        {
          type: 'message',
          message: { role: 'user', content: [{ type: 'text', text: `opened ${path}` }] },
        },
      ],
    }) as never;
  });

  afterAll(async () => {
    await module.close();
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.NUNCIO_DATA_DIR;
  });

  it('lists pi SDK sessions for a workspace and marks imported sessions by providerThreadId', async () => {
    const imported = repo.create({
      prompt: 'already imported',
      provider: 'pi',
      providerThreadId: piPath,
    });

    const items = await service.listForWorkspace(workspace);

    expect(items).toEqual([
      {
        sessionId: 'pi-session-id',
        path: piPath,
        workspace,
        title: 'Named pi task',
        preview: 'Please continue this pi task',
        updatedAt: new Date('2026-07-01T12:00:00Z').getTime(),
        messageCount: 3,
        alreadyImported: true,
        nuncioSessionId: imported.id,
      },
    ]);
  });

  it('opens a session through the pi SDK when hydrating', () => {
    expect(service.readTranscriptEvents(piPath)).toEqual({
      ok: true,
      events: [{ type: 'user_message', payload: { text: `opened ${piPath}` } }],
    });
  });

  it('distinguishes a successfully empty transcript from a failed read', () => {
    const previousOpenSession = service.openSession;
    service.openSession = () => ({ getEntries: () => [] }) as never;
    try {
      expect(service.readTranscriptEvents(piPath)).toEqual({ ok: true, events: [] });
    } finally {
      service.openSession = previousOpenSession;
    }
  });

  it('readModelMeta maps Pi buildSessionContext model and thinking level', () => {
    service.openSession = (path: string) => ({
      getEntries: () => [],
      buildSessionContext: () => {
        expect(path).toBe(piPath);
        return {
          model: { provider: 'cliproxy', modelId: 'claude-opus-4-8' },
          thinkingLevel: 'xhigh',
        };
      },
    }) as never;

    expect(service.readModelMeta(piPath)).toEqual({
      model: 'cliproxy:claude-opus-4-8',
      thinkingLevel: 'xhigh',
    });
  });

  it('readModelMeta returns null metadata when Pi context cannot be read', () => {
    service.openSession = () => {
      throw new Error('bad session');
    };

    expect(service.readModelMeta(piPath)).toEqual({ model: null, thinkingLevel: null });
  });

  it('returns an empty list for blank workspaces and when Pi list fails', async () => {
    expect(await service.listForWorkspace('   ')).toEqual([]);
    const previousLoadSdk = service.loadSdk;
    service.loadSdk = async () => ({
      SessionManager: {
        list: async () => {
          throw new Error('pi unavailable');
        },
      },
    } as never);
    expect(await service.listForWorkspace(workspace)).toEqual([]);
    service.loadSdk = previousLoadSdk;
  });

  it('caps listForWorkspace to the configured max limit', async () => {
    const previousLoadSdk = service.loadSdk;
    service.loadSdk = async () => ({
      SessionManager: {
        list: async () =>
          Array.from({ length: 60 }, (_, index) => ({
            id: `pi-${index}`,
            path: `${piPath}-${index}`,
            cwd: workspace,
            name: `Session ${index}`,
            firstMessage: `message ${index}`,
            messageCount: 1,
            modified: new Date(1_700_000_000_000 + index),
            created: new Date(1_700_000_000_000),
            allMessagesText: `message ${index}`,
          })),
      },
    } as never);

    const items = await service.listForWorkspace(workspace, 100);
    expect(items).toHaveLength(50);
    service.loadSdk = previousLoadSdk;
  });

  it('find returns a listed session when the path matches', async () => {
    const found = await service.find(piPath, workspace);
    expect(found).toMatchObject({
      path: piPath,
      workspace,
      title: 'Named pi task',
    });
  });

  it('readTranscriptEvents preserves repeated read failures', () => {
    let attempts = 0;
    service.openSession = () => {
      attempts += 1;
      throw new Error('missing file');
    };

    expect(service.readTranscriptEvents(piPath)).toMatchObject({ ok: false });
    expect(service.readTranscriptEvents(piPath)).toMatchObject({ ok: false });
    expect(attempts).toBe(2);
  });
});
