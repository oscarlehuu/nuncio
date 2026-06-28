import { ConflictException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CursorCliProvider } from '../../../src/agents/providers/cursor-cli.provider';
import { DatabaseModule } from '../../../src/db/database.module';
import { SettingsModule } from '../../../src/settings/settings.module';
import { SessionsPersistenceModule } from '../../../src/sessions/sessions.persistence.module';
import { SessionsRepository } from '../../../src/sessions/persistence/sessions.repository';

describe('CursorCliProvider active-run guard', () => {
  let module: TestingModule;
  let provider: CursorCliProvider;
  let dataDir: string;
  let fakeAgentBin: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-cli-guard-'));
    process.env.NUNCIO_DATA_DIR = dataDir;
    fakeAgentBin = join(tmpdir(), `nuncio-fake-agent-${Date.now()}`);
    writeFileSync(fakeAgentBin, '#!/bin/sh\nexit 0\n');
    chmodSync(fakeAgentBin, 0o755);
    process.env.NUNCIO_CURSOR_AGENT_BIN = fakeAgentBin;
    module = await Test.createTestingModule({
      imports: [DatabaseModule, SettingsModule, SessionsPersistenceModule],
      providers: [CursorCliProvider],
    }).compile();
    provider = module.get(CursorCliProvider);
    provider.runOverride = async () => 0;
  });

  afterAll(async () => {
    await module.close();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(fakeAgentBin, { force: true });
    delete process.env.NUNCIO_DATA_DIR;
    delete process.env.NUNCIO_CURSOR_AGENT_BIN;
  });

  it('blocks steer when transcript was updated recently', async () => {
    const sessions = module.get(SessionsRepository);
    const session = sessions.createHandoff({
      title: 'Guard',
      workspace: '/tmp/ws',
      cursorChatId: 'chat-guard',
      prompt: 'Guard',
    });

    await expect(
      provider.steer(session.id, 'go', {
        workspace: '/tmp/ws',
        cursorChatId: 'chat-guard',
        transcriptMtimeMs: Date.now(),
      }),
    ).rejects.toThrow(ConflictException);
  });

  it('allows steer when forceResume is set', async () => {
    const sessions = module.get(SessionsRepository);
    const session = sessions.createHandoff({
      title: 'Force',
      workspace: '/tmp/ws',
      cursorChatId: 'chat-force',
      prompt: 'Force',
    });

    await expect(
      provider.steer(session.id, 'go', {
        workspace: '/tmp/ws',
        cursorChatId: 'chat-force',
        transcriptMtimeMs: Date.now(),
        forceResume: true,
      }),
    ).resolves.toBeUndefined();
  });
});
