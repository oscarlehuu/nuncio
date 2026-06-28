import { beforeAll, afterAll, beforeEach, describe, it, expect, mock } from 'bun:test';
import { Test, TestingModule } from '@nestjs/testing';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PiAgentProvider } from '../../../src/agents/providers/pi-agent.provider';
import { DatabaseModule } from '../../../src/db/database.module';
import { SessionsPersistenceModule } from '../../../src/sessions/sessions.persistence.module';
import { SettingsModule } from '../../../src/settings/settings.module';

let availableModelCount = 0;

mock.module('@earendil-works/pi-coding-agent', () => ({
  AuthStorage: { create: () => ({}) },
  ModelRegistry: {
    create: () => ({
      getAvailable: () => Array.from({ length: availableModelCount }, (_, i) => ({
        provider: 'anthropic',
        id: `model-${i}`,
        name: `Model ${i}`,
      })),
      getProviderDisplayName: (provider: string) => provider,
      find: () => undefined,
    }),
  },
  getAgentDir: () => '/tmp/fake-pi',
}));

describe('PiAgentProvider', () => {
  let module: TestingModule;
  let provider: PiAgentProvider;
  let dataDir: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-pi-provider-'));
    process.env.NUNCIO_DATA_DIR = dataDir;

    module = await Test.createTestingModule({
      imports: [DatabaseModule, SessionsPersistenceModule, SettingsModule],
      providers: [PiAgentProvider],
    }).compile();

    provider = module.get(PiAgentProvider);
  });

  afterAll(async () => {
    await module.close();
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.NUNCIO_DATA_DIR;
  });

  beforeEach(() => {
    availableModelCount = 0;
    provider.bustCache();
  });

  it('is unavailable when the Pi registry has no models', async () => {
    expect(await provider.isAvailable()).toBe(false);
  });

  it('is available when the Pi registry reports models', async () => {
    availableModelCount = 1;
    provider.bustCache();
    expect(await provider.isAvailable()).toBe(true);
  });

  it('dispose is a no-op for an unknown session', () => {
    expect(() => provider.dispose('no-such-session')).not.toThrow();
  });
});
