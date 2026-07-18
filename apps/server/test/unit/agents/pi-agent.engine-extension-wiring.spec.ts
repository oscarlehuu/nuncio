import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { Test, TestingModule } from '@nestjs/testing';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PiAgentProvider } from '../../../src/agents/providers/pi-agent.provider';
import { NUNCIO_ENGINE_EXTENSION_NAME } from '../../../src/agents/pi-engine/engine-extension';
import { DatabaseModule } from '../../../src/db/database.module';
import { SessionsRepository } from '../../../src/sessions/persistence/sessions.repository';
import { SessionsPersistenceModule } from '../../../src/sessions/sessions.persistence.module';
import { SettingsModule } from '../../../src/settings/settings.module';

/**
 * The engine resource loader must carry the in-repo `nuncio-engine` inline
 * extension (the rail every Engine hook rides). Same stub-injection pattern as
 * pi-agent.cwd.spec.ts — no real SDK.
 */

type LoaderOptions = Record<string, unknown>;

let loaderOptions: LoaderOptions[] = [];

const makePiSdkStub = () => ({
  AuthStorage: { create: () => ({}) },
  SettingsManager: { create: () => ({}) },
  ModelRegistry: {
    create: () => ({
      getError: () => undefined,
      getAvailable: () => [],
      getProviderDisplayName: (provider: string) => provider,
      find: () => undefined,
    }),
  },
  SessionManager: {},
  DefaultResourceLoader: class {
    constructor(readonly options: LoaderOptions) {
      loaderOptions.push(options);
    }
    async reload() {}
  },
  createAgentSession: () => ({
    session: {
      sessionFile: '/tmp/fake-pi/session.jsonl',
      subscribe: () => () => {},
      prompt: async () => {},
    },
  }),
  getAgentDir: () => '/tmp/default-pi-agent',
  createReadTool: (cwd: string) => ({ name: 'read', cwd }),
  createBashTool: (cwd: string) => ({ name: 'bash', cwd }),
  createEditTool: (cwd: string) => ({ name: 'edit', cwd }),
  createWriteTool: (cwd: string) => ({ name: 'write', cwd }),
  createGrepTool: (cwd: string) => ({ name: 'grep', cwd }),
  createFindTool: (cwd: string) => ({ name: 'find', cwd }),
  createLsTool: (cwd: string) => ({ name: 'ls', cwd }),
});

function injectPiSdkStub(provider: PiAgentProvider): void {
  (provider as unknown as { piSdkPromise: Promise<unknown> }).piSdkPromise =
    Promise.resolve(makePiSdkStub());
}

function engineLoaderOptions(): LoaderOptions {
  const options = loaderOptions.at(-1);
  if (!options) throw new Error('DefaultResourceLoader was not constructed');
  return options;
}

function inlineExtensionNames(options: LoaderOptions): string[] {
  const factories = (options.extensionFactories ?? []) as Array<{ name?: string }>;
  return factories.map((factory) => factory.name ?? '<anonymous>');
}

describe('PiAgentProvider engine extension wiring', () => {
  let module: TestingModule;
  let provider: PiAgentProvider;
  let sessions: SessionsRepository;
  let dataDir: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-pi-engine-wiring-'));
    process.env.NUNCIO_DATA_DIR = dataDir;

    module = await Test.createTestingModule({
      imports: [DatabaseModule, SessionsPersistenceModule, SettingsModule],
      providers: [PiAgentProvider],
    }).compile();

    provider = module.get(PiAgentProvider);
    sessions = module.get(SessionsRepository);
  });

  afterAll(async () => {
    await module.close();
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.NUNCIO_DATA_DIR;
    delete process.env.PI_AGENT_DIR;
    delete process.env.NUNCIO_ENGINE_GATE_GUARD;
  });

  beforeEach(() => {
    loaderOptions = [];
    process.env.PI_AGENT_DIR = '/tmp/custom-pi-agent';
    delete process.env.NUNCIO_ENGINE_GATE_GUARD;
    injectPiSdkStub(provider);
  });

  it('passes the nuncio-engine inline extension on the engine resource loader', async () => {
    const created = sessions.create({ prompt: 'engine rail', provider: 'pi' });

    await provider.run(created.id, created.prompt, {
      cwd: '/tmp/workspaces/rail-session',
      emit: () => {},
    });

    expect(inlineExtensionNames(engineLoaderOptions())).toContain(NUNCIO_ENGINE_EXTENSION_NAME);
  });

  it('keeps the rail attached when full discovery is enabled', async () => {
    process.env.PI_EXTENSION_DISCOVERY = 'full';
    try {
      const created = sessions.create({ prompt: 'full discovery', provider: 'pi' });
      await provider.run(created.id, created.prompt, {
        cwd: '/tmp/workspaces/full-disc',
        emit: () => {},
      });
      const options = engineLoaderOptions();
      expect('noExtensions' in options).toBe(false);
      expect(inlineExtensionNames(options)).toContain(NUNCIO_ENGINE_EXTENSION_NAME);
    } finally {
      delete process.env.PI_EXTENSION_DISCOVERY;
    }
  });

  it('omits the rail entirely when the gate guard is switched off', async () => {
    process.env.NUNCIO_ENGINE_GATE_GUARD = 'off';
    const created = sessions.create({ prompt: 'guard off', provider: 'pi' });

    await provider.run(created.id, created.prompt, {
      cwd: '/tmp/workspaces/guard-off',
      emit: () => {},
    });

    expect(inlineExtensionNames(engineLoaderOptions())).not.toContain(
      NUNCIO_ENGINE_EXTENSION_NAME,
    );
  });
});
