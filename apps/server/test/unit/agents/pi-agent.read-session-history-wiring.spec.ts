import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { Test, TestingModule } from '@nestjs/testing';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PiAgentProvider } from '../../../src/agents/providers/pi-agent.provider';
import { READ_SESSION_HISTORY_TOOL_NAME } from '../../../src/agents/pi-engine/read-session-history-tool';
import { DatabaseModule } from '../../../src/db/database.module';
import { EventsRepository } from '../../../src/sessions/persistence/events.repository';
import { SessionsRepository } from '../../../src/sessions/persistence/sessions.repository';
import { SessionsPersistenceModule } from '../../../src/sessions/sessions.persistence.module';
import { SettingsModule } from '../../../src/settings/settings.module';

/**
 * Solo Nuncio Engine sessions carry read_session_history wired to the durable
 * event log, so a compaction pointer can actually be followed. Policy sessions
 * (Crew members) do not get it in this round — deferred with Crew compaction.
 */

type CreateAgentSessionOptions = Record<string, unknown>;
type ToolShape = {
  name: string;
  execute: (toolCallId: string, params: unknown) => Promise<{
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  }>;
};

let createAgentSessionOptions: CreateAgentSessionOptions[] = [];

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
    constructor(readonly options: Record<string, unknown>) {}
    async reload() {}
  },
  createAgentSession: (options: CreateAgentSessionOptions) => {
    createAgentSessionOptions.push(options);
    return {
      session: {
        sessionFile: '/tmp/fake-pi/session.jsonl',
        subscribe: () => () => {},
        prompt: async () => {},
      },
    };
  },
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

function latestCustomTools(): ToolShape[] {
  const options = createAgentSessionOptions.at(-1);
  if (!options) throw new Error('createAgentSession was not called');
  return options.customTools as ToolShape[];
}

describe('PiAgentProvider read_session_history wiring', () => {
  let module: TestingModule;
  let provider: PiAgentProvider;
  let sessions: SessionsRepository;
  let events: EventsRepository;
  let dataDir: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-pi-history-wiring-'));
    process.env.NUNCIO_DATA_DIR = dataDir;

    module = await Test.createTestingModule({
      imports: [DatabaseModule, SessionsPersistenceModule, SettingsModule],
      providers: [PiAgentProvider],
    }).compile();

    provider = module.get(PiAgentProvider);
    sessions = module.get(SessionsRepository);
    events = module.get(EventsRepository);
  });

  afterAll(async () => {
    await module.close();
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.NUNCIO_DATA_DIR;
    delete process.env.PI_AGENT_DIR;
  });

  beforeEach(() => {
    createAgentSessionOptions = [];
    process.env.PI_AGENT_DIR = '/tmp/custom-pi-agent';
    injectPiSdkStub(provider);
  });

  it('wires read_session_history to the session-scoped durable log', async () => {
    const created = sessions.create({ prompt: 'long session', provider: 'pi' });
    events.append(created.id, 'user_message', { text: 'the original compacted ask' });
    events.append(created.id, 'assistant_message', { text: 'the original compacted answer' });

    await provider.run(created.id, created.prompt, {
      cwd: '/tmp/workspaces/history-session',
      emit: () => {},
    });

    const tool = latestCustomTools().find((t) => t.name === READ_SESSION_HISTORY_TOOL_NAME);
    expect(tool).toBeDefined();
    const result = await tool!.execute('call-1', {});
    expect(result.content[0]!.text).toContain('the original compacted ask');
    expect(result.content[0]!.text).toContain('the original compacted answer');
  });

  it('does not expose read_session_history to runtime-policy sessions', async () => {
    const workspaceRoot = realpathSync(mkdtempSync(join(tmpdir(), 'nuncio-history-policy-')));
    try {
      const created = sessions.create({ prompt: 'crew member', provider: 'pi' });
      await provider.run(created.id, created.prompt, {
        cwd: workspaceRoot,
        runtimePolicy: { filesystem: 'read-only', workspaceRoot, network: 'disabled' },
        emit: () => {},
      });

      expect(latestCustomTools().map((t) => t.name)).not.toContain(READ_SESSION_HISTORY_TOOL_NAME);
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });
});
