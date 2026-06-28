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
import { SettingsModule } from '../../../src/settings/settings.module';

describe('SessionsService.handoff', () => {
  let module: TestingModule;
  let service: SessionsService;
  let fakeHome: string;
  let workspace: string;
  let dataDir: string;
  const chatId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

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
      imports: [DatabaseModule, SettingsModule, AgentsModule, GitModule, CursorLocalModule, SessionsModule],
    }).compile();
    service = module.get(SessionsService);
    const local = module.get(CursorLocalSessionsService);
    local.homeDir = () => fakeHome;
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

  it('404 when chat does not exist', async () => {
    await expect(
      service.handoff({ cursorChatId: '00000000-0000-0000-0000-000000000000', workspace }),
    ).rejects.toThrow(NotFoundException);
  });
});
