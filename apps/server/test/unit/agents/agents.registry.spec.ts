import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentRegistry } from '../../../src/agents/agents.registry';
import { AgentsModule } from '../../../src/agents/agents.module';
import { CodexAgentProvider } from '../../../src/agents/providers/codex-agent.provider';
import { CursorAgentProvider } from '../../../src/agents/providers/cursor-agent.provider';
import { PiAgentProvider } from '../../../src/agents/providers/pi-agent.provider';
import { DatabaseModule } from '../../../src/db/database.module';
import { SessionsPersistenceModule } from '../../../src/sessions/sessions.persistence.module';
import { stubAgentProvider } from '../../helpers/stub-agent-provider';

describe('AgentRegistry', () => {
  let module: TestingModule;
  let dataDir: string;

  afterEach(async () => {
    if (module) await module.close();
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
    delete process.env.NUNCIO_DATA_DIR;
    delete process.env.CURSOR_API_KEY;
  });

  async function createRegistry(builder = Test.createTestingModule({
    imports: [DatabaseModule, SessionsPersistenceModule, AgentsModule],
  })) {
    if (module) await module.close();
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });

    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-registry-test-'));
    process.env.NUNCIO_DATA_DIR = dataDir;

    module = await builder.compile();
    return module.get(AgentRegistry);
  }

  it('throws when no real providers are available', async () => {
    delete process.env.CURSOR_API_KEY;
    const registry = await createRegistry(
      Test.createTestingModule({
        imports: [DatabaseModule, SessionsPersistenceModule, AgentsModule],
      })
	        .overrideProvider(PiAgentProvider)
	        .useValue(stubAgentProvider('pi', 'Pi', false))
	        .overrideProvider(CursorAgentProvider)
	        .useValue(stubAgentProvider('cursor', 'Cursor', false))
	        .overrideProvider(CodexAgentProvider)
	        .useValue(stubAgentProvider('codex', 'Codex', false)),
	    );

    await expect(registry.defaultId()).rejects.toThrow(ServiceUnavailableException);
    expect((await registry.available()).map((provider) => provider.id)).toEqual([]);
  });

  it('prefers cursor as default when CURSOR_API_KEY is set', async () => {
    process.env.CURSOR_API_KEY = 'cursor_test_key';
    const registry = await createRegistry();

    expect(await registry.defaultId()).toBe('cursor');
  });

  it('rejects unknown providers', async () => {
    const registry = await createRegistry();

    expect(() => registry.get('missing')).toThrow(BadRequestException);
    expect(() => registry.get('mock')).toThrow(BadRequestException);
  });

  it('get returns a registered provider by id', async () => {
    const registry = await createRegistry();

	    expect(registry.get('pi').id).toBe('pi');
	    expect(registry.get('cursor').id).toBe('cursor');
	    expect(registry.get('codex').id).toBe('codex');
	  });

	  it('exposes every registered provider via all()', async () => {
	    const registry = await createRegistry();

	    expect(registry.all().map((provider) => provider.id).sort()).toEqual(['codex', 'cursor', 'pi']);
	  });

  it('rejects an unavailable provider via getAvailable', async () => {
    const registry = await createRegistry(
      Test.createTestingModule({
        imports: [DatabaseModule, SessionsPersistenceModule, AgentsModule],
      })
        .overrideProvider(PiAgentProvider)
        .useValue(stubAgentProvider('pi', 'Pi', false)),
    );

    await expect(registry.getAvailable('pi')).rejects.toThrow(BadRequestException);
  });

  it('rejects cursor when CURSOR_API_KEY is missing', async () => {
    delete process.env.CURSOR_API_KEY;
    const registry = await createRegistry();

    await expect(registry.getAvailable('cursor')).rejects.toThrow(BadRequestException);
  });

	  it('resolves cursor when CURSOR_API_KEY is set', async () => {
    process.env.CURSOR_API_KEY = 'cursor_test_key';
    const registry = await createRegistry();

    const provider = await registry.getAvailable('cursor');
	    expect(provider.id).toBe('cursor');
	  });

	  it('uses codex as default after cursor and before pi', async () => {
	    const registry = await createRegistry(
	      Test.createTestingModule({
	        imports: [DatabaseModule, SessionsPersistenceModule, AgentsModule],
	      })
	        .overrideProvider(CursorAgentProvider)
	        .useValue(stubAgentProvider('cursor', 'Cursor', false))
	        .overrideProvider(CodexAgentProvider)
	        .useValue(stubAgentProvider('codex', 'Codex', true))
	        .overrideProvider(PiAgentProvider)
	        .useValue(stubAgentProvider('pi', 'Pi', true)),
	    );

	    expect(await registry.defaultId()).toBe('codex');
	  });
	});
