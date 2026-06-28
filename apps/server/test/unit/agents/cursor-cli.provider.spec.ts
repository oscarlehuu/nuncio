import { Test, TestingModule } from '@nestjs/testing';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CursorCliProvider } from '../../../src/agents/providers/cursor-cli.provider';
import { DatabaseModule } from '../../../src/db/database.module';
import { SettingsModule } from '../../../src/settings/settings.module';
import { SessionsPersistenceModule } from '../../../src/sessions/sessions.persistence.module';
import { SessionsRepository } from '../../../src/sessions/persistence/sessions.repository';
import { EventsRepository } from '../../../src/sessions/persistence/events.repository';

describe('CursorCliProvider', () => {
  let module: TestingModule;
  let provider: CursorCliProvider;
  let dataDir: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-cli-prov-'));
    process.env.NUNCIO_DATA_DIR = dataDir;

    module = await Test.createTestingModule({
      imports: [DatabaseModule, SettingsModule, SessionsPersistenceModule],
      providers: [CursorCliProvider],
    }).compile();
    provider = module.get(CursorCliProvider);
  });

  afterAll(async () => {
    await module.close();
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.NUNCIO_DATA_DIR;
  });

  it('streams assistant deltas and final message from stub runner', async () => {
    const sessions = module.get(SessionsRepository);
    const events = module.get(EventsRepository);
    const session = sessions.createHandoff({
      title: 'Handoff',
      workspace: '/tmp/ws',
      cursorChatId: 'chat-1',
      prompt: 'Handoff',
    });

    const emitted: string[] = [];
    provider.runOverride = async (_id, _args, ctx) => {
      ctx.emit?.({ type: 'assistant_delta', payload: { delta: 'P' } });
      ctx.emit?.({ type: 'assistant_message', payload: { text: 'PONG' } });
      return 0;
    };

    await provider.steer(session.id, 'go', {
      workspace: '/tmp/ws',
      cursorChatId: 'chat-1',
      transcriptMtimeMs: 0,
      emit: (e) => emitted.push(e.type),
    });

    expect(emitted).toContain('assistant_delta');
    expect(emitted).toContain('assistant_message');
    const stored = events.list(session.id);
    expect(stored.some((e) => e.type === 'assistant_message')).toBe(true);
    expect(sessions.findById(session.id)?.status).toBe('IDLE');
  });
});
