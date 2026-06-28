import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Test, TestingModule } from '@nestjs/testing';
import { toProjectSlug } from '../../../src/cursor-local/cursor-project-slug';
import { CursorLocalModule } from '../../../src/cursor-local/cursor-local.module';
import { CursorLocalSessionsService } from '../../../src/cursor-local/cursor-local-sessions.service';
import { CursorCliProvider } from '../../../src/agents/providers/cursor-cli.provider';
import { DatabaseModule } from '../../../src/db/database.module';
import { SessionsModule } from '../../../src/sessions/sessions.module';
import { SessionsService } from '../../../src/sessions/sessions.service';
import { AgentsModule } from '../../../src/agents/agents.module';
import { GitModule } from '../../../src/git/git.module';
import { SettingsModule } from '../../../src/settings/settings.module';
import { EventsRepository } from '../../../src/sessions/persistence/events.repository';

describe('SessionsService.refreshTranscriptIfNeeded', () => {
  let module: TestingModule;
  let service: SessionsService;
  let events: EventsRepository;
  let fakeHome: string;
  let workspace: string;
  let dataDir: string;
  let fakeAgentBin: string;
  const chatId = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-rehydrate-db-'));
    process.env.NUNCIO_DATA_DIR = dataDir;
    fakeAgentBin = join(tmpdir(), `nuncio-fake-agent-${Date.now()}`);
    writeFileSync(fakeAgentBin, '#!/bin/sh\nexit 0\n');
    chmodSync(fakeAgentBin, 0o755);
    process.env.NUNCIO_CURSOR_AGENT_BIN = fakeAgentBin;

    fakeHome = mkdtempSync(join(tmpdir(), 'nuncio-rehydrate-'));
    workspace = join(fakeHome, 'repo');
    const slug = toProjectSlug(workspace);
    const dir = join(fakeHome, '.cursor/projects', slug, 'agent-transcripts', chatId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `${chatId}.jsonl`),
      JSON.stringify({
        role: 'user',
        message: { content: [{ type: 'text', text: 'First message' }] },
      }) + '\n',
    );

    module = await Test.createTestingModule({
      imports: [DatabaseModule, SettingsModule, AgentsModule, GitModule, CursorLocalModule, SessionsModule],
    }).compile();
    service = module.get(SessionsService);
    events = module.get(EventsRepository);
    module.get(CursorLocalSessionsService).homeDir = () => fakeHome;
    module.get(CursorCliProvider).runOverride = async () => 0;
  });

  afterAll(async () => {
    await module.close();
    rmSync(fakeHome, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(fakeAgentBin, { force: true });
    delete process.env.NUNCIO_DATA_DIR;
    delete process.env.NUNCIO_CURSOR_AGENT_BIN;
  });

  it('appends new transcript turns before steer without duplicating existing events', async () => {
    const session = await service.handoff({ cursorChatId: chatId, workspace });
    expect(events.list(session.id).filter((e) => e.type === 'user_message')).toHaveLength(1);

    const slug = toProjectSlug(workspace);
    const jsonl = join(
      fakeHome,
      '.cursor/projects',
      slug,
      'agent-transcripts',
      chatId,
      `${chatId}.jsonl`,
    );
    writeFileSync(
      jsonl,
      [
        JSON.stringify({
          role: 'user',
          message: { content: [{ type: 'text', text: 'First message' }] },
        }),
        JSON.stringify({
          role: 'user',
          message: { content: [{ type: 'text', text: 'Follow up on Mac' }] },
        }),
      ].join('\n') + '\n',
    );

    await service.steer(session.id, 'continue from phone', true);

    const userMessages = events.list(session.id).filter((e) => e.type === 'user_message');
    expect(userMessages.length).toBeGreaterThanOrEqual(2);
    expect(
      userMessages.some((e) => (e.payload as { text: string }).text === 'Follow up on Mac'),
    ).toBe(true);
  });
});
