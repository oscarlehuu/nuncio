import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Test, TestingModule } from '@nestjs/testing';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { AgentsModule } from '../../src/agents/agents.module';
import { CursorLocalModule } from '../../src/cursor-local/cursor-local.module';
import { DatabaseModule } from '../../src/db/database.module';
import { GitModule } from '../../src/git/git.module';
import { SettingsModule } from '../../src/settings/settings.module';
import { SessionsModule } from '../../src/sessions/sessions.module';
import { SessionsService } from '../../src/sessions/sessions.service';

const agentBin =
  process.env.NUNCIO_CURSOR_AGENT_BIN ?? join(homedir(), '.local/bin/agent');
const fixtureChatId = process.env.NUNCIO_HANDOFF_CHAT_ID?.trim();
const fixtureWorkspace = process.env.NUNCIO_HANDOFF_WORKSPACE?.trim();
const hasCliIntegration =
  existsSync(agentBin) && Boolean(fixtureChatId) && Boolean(fixtureWorkspace);

const suite = hasCliIntegration ? describe : describe.skip;

suite('Cursor CLI handoff (integration)', () => {
  let module: TestingModule;
  let service: SessionsService;
  let dataDir: string;
  let sessionId: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-cli-integration-'));
    process.env.NUNCIO_DATA_DIR = dataDir;
    process.env.NUNCIO_CURSOR_AGENT_BIN = agentBin;

    module = await Test.createTestingModule({
      imports: [DatabaseModule, SettingsModule, AgentsModule, GitModule, CursorLocalModule, SessionsModule],
    }).compile();
    service = module.get(SessionsService);
  }, 60_000);

  afterAll(async () => {
    if (sessionId) {
      try {
        await service.archive(sessionId);
        service.delete(sessionId);
      } catch {
        // best-effort cleanup
      }
    }
    await module?.close();
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.NUNCIO_DATA_DIR;
  }, 60_000);

  it('handoffs and steers a real Cursor CLI chat', async () => {
    const session = await service.handoff({
      cursorChatId: fixtureChatId!,
      workspace: fixtureWorkspace!,
    });
    sessionId = session.id;
    expect(session.cursorBackend).toBe('cli');

    await service.steer(sessionId, 'Reply with exactly: INTEGRATION-OK', true);

    const events = service.getEvents(sessionId);
    expect(events.some((e) => e.type === 'assistant_message' || e.type === 'assistant_delta')).toBe(
      true,
    );
  }, 120_000);
});
