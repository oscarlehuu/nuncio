import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { toProjectSlug } from '../../../src/cursor-local/cursor-project-slug';
import { CursorLocalModule } from '../../../src/cursor-local/cursor-local.module';
import { CursorLocalSessionsService } from '../../../src/cursor-local/cursor-local-sessions.service';
import { DatabaseModule } from '../../../src/db/database.module';
import { SessionsModule } from '../../../src/sessions/sessions.module';
import { SessionsService } from '../../../src/sessions/sessions.service';
import { AgentsModule } from '../../../src/agents/agents.module';
import { GitModule } from '../../../src/git/git.module';
import { GitService } from '../../../src/git/git.service';
import { SettingsModule } from '../../../src/settings/settings.module';
import { PiLocalModule } from '../../../src/pi-local/pi-local.module';
import { PiLocalSessionsService } from '../../../src/pi-local/pi-local-sessions.service';

describe('SessionsService.handoff', () => {
  let module: TestingModule;
  let service: SessionsService;
  let fakeHome: string;
  let workspace: string;
  let dataDir: string;
  let currentBranchCalls: string[];
  const chatId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const piPath = '/Users/me/.pi/agent/sessions/repo/20260701_pi.jsonl';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-handoff-db-'));
    process.env.NUNCIO_DATA_DIR = dataDir;

    fakeHome = mkdtempSync(join(tmpdir(), 'nuncio-handoff-'));
    workspace = join(fakeHome, 'repo');
    const slug = toProjectSlug(workspace);
    const dir = join(fakeHome, '.cursor/projects', slug, 'agent-transcripts', chatId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `${chatId}.jsonl`),
      JSON.stringify({
        role: 'user',
        message: { content: [{ type: 'text', text: 'Continue this work' }] },
      }) + '\n',
    );

    module = await Test.createTestingModule({
      imports: [
        DatabaseModule,
        SettingsModule,
        AgentsModule,
        GitModule,
        CursorLocalModule,
        PiLocalModule,
        SessionsModule,
      ],
    }).compile();
    service = module.get(SessionsService);
    currentBranchCalls = [];
    const local = module.get(CursorLocalSessionsService);
    local.homeDir = () => fakeHome;
    const piLocal = module.get(PiLocalSessionsService);
    piLocal.loadSdk = async () => ({
      SessionManager: {
        list: async () => [
          {
            id: 'pi-session-id',
            path: piPath,
            cwd: workspace,
            name: 'Pi CLI task',
            firstMessage: 'Continue pi',
            messageCount: 2,
            modified: new Date('2026-07-01T12:00:00Z'),
            created: new Date('2026-07-01T11:00:00Z'),
            allMessagesText: 'Continue pi\nPi reply',
          },
        ],
      },
    } as never);
    piLocal.openSession = (path: string) => ({
      getEntries: () => [
        {
          type: 'message',
          message: { role: 'user', content: [{ type: 'text', text: `opened ${path}` }] },
        },
      ],
    }) as never;
    (piLocal as PiLocalSessionsService & {
      readModelMeta: (path: string) => { model: string | null; thinkingLevel: string | null };
    }).readModelMeta = (path: string) => {
      expect(path).toBe(piPath);
      return { model: 'cliproxy:claude-opus-4-8', thinkingLevel: 'xhigh' };
    };
    const git = module.get(GitService) as GitService & {
      currentBranch: (path: string) => Promise<string | null>;
    };
    git.currentBranch = async (path: string) => {
      currentBranchCalls.push(path);
      return 'feature/pi-import-meta';
    };
  });

  afterAll(async () => {
    await module.close();
    rmSync(fakeHome, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.NUNCIO_DATA_DIR;
  });

  it('imports a selected cursor chat as an IDLE cli session', async () => {
    const session = await service.handoff({ cursorChatId: chatId, workspace });
    expect(session.cursorBackend).toBe('cli');
    expect(session.cursorChatId).toBe(chatId);
    expect(session.status).toBe('IDLE');
    expect(session.provider).toBe('cursor');

    const events = service.getEvents(session.id);
    expect(events.some((e) => e.type === 'user_message')).toBe(true);
  });

  it('is idempotent for the same chatId', async () => {
    const first = await service.handoff({ cursorChatId: chatId, workspace });
    const second = await service.handoff({ cursorChatId: chatId, workspace });
    expect(second.id).toBe(first.id);
  });

  it('imports a selected pi CLI session with model metadata and current git branch', async () => {
    const session = await service.handoff({ piSessionPath: piPath, workspace, title: 'Pi CLI task' });

    expect(session.provider).toBe('pi');
    expect(session.providerThreadId).toBe(piPath);
    expect(session.cursorBackend).toBeNull();
    expect(session.cursorChatId).toBeNull();
    expect(session.status).toBe('IDLE');
    expect(session.model).toBe('cliproxy:claude-opus-4-8');
    expect(session.modelOptions).toEqual({ thinkingLevel: 'xhigh' });
    expect(session.branch).toBe('feature/pi-import-meta');
    expect(currentBranchCalls).toContain(workspace);

    const events = service.getEvents(session.id);
    expect(events).toEqual([
      expect.objectContaining({ type: 'user_message', payload: { text: `opened ${piPath}` } }),
    ]);
  });

  it('is idempotent for the same pi providerThreadId', async () => {
    const first = await service.handoff({ piSessionPath: piPath, workspace, title: 'Pi CLI task' });
    const second = await service.handoff({ piSessionPath: piPath, workspace, title: 'Pi CLI task' });
    expect(second.id).toBe(first.id);
  });

  it('404 when chat does not exist', async () => {
    await expect(
      service.handoff({ cursorChatId: '00000000-0000-0000-0000-000000000000', workspace }),
    ).rejects.toThrow(NotFoundException);
  });
});
