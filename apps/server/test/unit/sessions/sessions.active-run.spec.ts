import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
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
import { SessionsRepository } from '../../../src/sessions/persistence/sessions.repository';

describe('SessionsService cursor CLI active-run', () => {
  let module: TestingModule;
  let service: SessionsService;
  let fakeHome: string;
  let workspace: string;
  let dataDir: string;
  const chatId = 'dddddddd-dddd-dddd-dddd-dddddddddddd';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-active-run-db-'));
    process.env.NUNCIO_DATA_DIR = dataDir;

    fakeHome = mkdtempSync(join(tmpdir(), 'nuncio-active-run-'));
    workspace = join(fakeHome, 'repo');
    const slug = toProjectSlug(workspace);
    const dir = join(fakeHome, '.cursor/projects', slug, 'agent-transcripts', chatId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `${chatId}.jsonl`),
      JSON.stringify({
        role: 'user',
        message: { content: [{ type: 'text', text: 'Hello' }] },
      }) + '\n',
    );

    module = await Test.createTestingModule({
      imports: [DatabaseModule, SettingsModule, AgentsModule, GitModule, CursorLocalModule, SessionsModule],
    }).compile();
    service = module.get(SessionsService);
    module.get(CursorLocalSessionsService).homeDir = () => fakeHome;
  });

  afterAll(async () => {
    await module.close();
    rmSync(fakeHome, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.NUNCIO_DATA_DIR;
  });

  it('isCursorCliActive returns true when transcript mtime is recent', async () => {
    const session = await service.handoff({ cursorChatId: chatId, workspace });
    expect(service.isCursorCliActive(session.id)).toBe(true);
  });

  it('isCursorCliActive returns false for non-CLI sessions', () => {
    const sessions = module.get(SessionsRepository);
    const sdk = sessions.create({
      prompt: 'sdk task',
      provider: 'cursor',
      cursorBackend: 'sdk',
    });
    expect(service.isCursorCliActive(sdk.id)).toBe(false);
  });

  it('refreshTranscript appends new turns from disk', async () => {
    const session = await service.handoff({ cursorChatId: chatId, workspace });
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
          message: { content: [{ type: 'text', text: 'Hello' }] },
        }),
        JSON.stringify({
          role: 'assistant',
          message: { content: [{ type: 'text', text: 'Done on Mac' }] },
        }),
      ].join('\n') + '\n',
    );

    const result = service.refreshTranscript(session.id);
    expect(result.added).toBeGreaterThanOrEqual(1);
  });
});
