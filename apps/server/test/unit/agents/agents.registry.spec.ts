import { BadRequestException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentRegistry } from '../../../src/agents/agents.registry';
import { AgentsModule } from '../../../src/agents/agents.module';
import { DatabaseModule } from '../../../src/db/database.module';
import { SessionsPersistenceModule } from '../../../src/sessions/sessions.persistence.module';

describe('AgentRegistry', () => {
  let module: TestingModule;
  let dataDir: string;

  afterEach(async () => {
    if (module) await module.close();
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
    delete process.env.NUNCIO_DATA_DIR;
    delete process.env.NUNCIO_FORCE_MOCK;
  });

  async function createRegistry(forceMock: boolean) {
    if (module) await module.close();
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });

    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-registry-test-'));
    process.env.NUNCIO_DATA_DIR = dataDir;
    if (forceMock) process.env.NUNCIO_FORCE_MOCK = '1';
    else delete process.env.NUNCIO_FORCE_MOCK;

    module = await Test.createTestingModule({
      imports: [DatabaseModule, SessionsPersistenceModule, AgentsModule],
    }).compile();

    return module.get(AgentRegistry);
  }

  it('uses mock as default when real providers are unavailable', async () => {
    const registry = await createRegistry(true);

    expect(await registry.defaultId()).toBe('mock');
    expect((await registry.available()).map((provider) => provider.id)).toEqual(['mock']);
  });

  it('rejects unknown providers', async () => {
    const registry = await createRegistry(true);

    expect(() => registry.get('missing')).toThrow(BadRequestException);
  });

  it('exposes every registered provider via all()', async () => {
    const registry = await createRegistry(true);

    expect(registry.all().map((provider) => provider.id).sort()).toEqual(['cursor', 'mock', 'pi']);
  });

  it('rejects an unavailable provider via getAvailable', async () => {
    const registry = await createRegistry(true);

    await expect(registry.getAvailable('pi')).rejects.toThrow(BadRequestException);
  });

  it('rejects cursor when CURSOR_API_KEY is missing', async () => {
    delete process.env.CURSOR_API_KEY;
    const registry = await createRegistry(false);

    await expect(registry.getAvailable('cursor')).rejects.toThrow(BadRequestException);
  });

  it('resolves cursor when CURSOR_API_KEY is set', async () => {
    process.env.CURSOR_API_KEY = 'cursor_test_key';
    const registry = await createRegistry(false);

    const provider = await registry.getAvailable('cursor');
    expect(provider.id).toBe('cursor');
  });
});
