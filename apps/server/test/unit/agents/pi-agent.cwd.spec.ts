import { describe, it, expect, mock, beforeAll, afterAll } from 'bun:test';
import { Test, TestingModule } from '@nestjs/testing';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseModule } from '../../../src/db/database.module';
import { SessionsPersistenceModule } from '../../../src/sessions/sessions.persistence.module';
import { SessionsRepository } from '../../../src/sessions/persistence/sessions.repository';
import { EventsRepository } from '../../../src/sessions/persistence/events.repository';
import { PiAgentProvider } from '../../../src/agents/providers/pi-agent.provider';

// Captured across the SDK mock so assertions can inspect what the provider passed.
let capturedCreateOptions: {
  cwd?: string;
  sessionManager?: unknown;
  tools?: string[];
  customTools?: unknown[];
} | null = null;

const inMemoryCalls: Array<string | undefined> = [];
const toolFactoryCalls: Array<{ kind: string; cwd?: string }> = [];

// Stub the Pi SDK so createAgentSession never makes a real LLM call.
// Captures the options the provider assembles (cwd + sessionManager + customTools)
// for assertion. The tool factories (createBashTool etc.) record their cwd arg so
// we can prove Nuncio rebinds tools to the worktree cwd when claude-studio-style
// extensions would otherwise bind them to process.cwd().
mock.module('@earendil-works/pi-coding-agent', () => {
  const makeToolFactory = (kind: string) => (cwd?: string) => {
    toolFactoryCalls.push({ kind, cwd });
    return { name: kind, execute: async () => ({ content: [] }) };
  };
  return {
    getAgentDir: () => '/tmp/fake-pi-agent-dir',
    AuthStorage: { create: () => ({}) },
    ModelRegistry: {
      create: () => ({
        getAvailable: () => [{ provider: 'anthropic', id: 'claude-fable-5', name: 'Fable 5' }],
        getProviderDisplayName: (p: string) => p,
        find: () => ({ provider: 'anthropic', id: 'claude-fable-5' }),
      }),
    },
    SessionManager: {
      inMemory: (cwd?: string) => {
        inMemoryCalls.push(cwd);
        return { kind: 'inMemory', cwd };
      },
    },
    createReadTool: makeToolFactory('read'),
    createBashTool: makeToolFactory('bash'),
    createEditTool: makeToolFactory('edit'),
    createWriteTool: makeToolFactory('write'),
    createGrepTool: makeToolFactory('grep'),
    createFindTool: makeToolFactory('find'),
    createLsTool: makeToolFactory('ls'),
    createAgentSession: async (options: {
      cwd?: string;
      sessionManager?: unknown;
      tools?: string[];
      customTools?: unknown[];
    }) => {
      capturedCreateOptions = options;
      const session = {
        subscribe: () => () => {},
        prompt: async () => {},
      };
      return { session };
    },
  };
});

describe('PiAgentProvider cwd threading', () => {
  let module: TestingModule;
  let provider: PiAgentProvider;
  let sessions: SessionsRepository;
  let dataDir: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-pi-cwd-'));
    process.env.NUNCIO_DATA_DIR = dataDir;
    // Deliberately NOT setting NUNCIO_FORCE_MOCK — run() must reach createPiSession
    // and use the mocked SDK above.

    module = await Test.createTestingModule({
      imports: [DatabaseModule, SessionsPersistenceModule],
      providers: [PiAgentProvider],
    }).compile();

    provider = module.get(PiAgentProvider);
    sessions = module.get(SessionsRepository);
  });

  afterAll(async () => {
    await module.close();
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.NUNCIO_DATA_DIR;
  });

  it('passes context.cwd to createAgentSession and builds SessionManager.inMemory(cwd)', async () => {
    const created = sessions.create({ prompt: 'work in worktree', provider: 'pi' });
    const worktreePath = '/tmp/nuncio-workspaces/abc12345';

    await provider.run(created.id, created.prompt, {
      emit: () => {},
      cwd: worktreePath,
    });

    expect(capturedCreateOptions).not.toBeNull();
    expect(capturedCreateOptions?.cwd).toBe(worktreePath);
    expect(inMemoryCalls).toContain(worktreePath);
    expect(capturedCreateOptions?.sessionManager).toEqual({ kind: 'inMemory', cwd: worktreePath });
  });

  it('overrides built-in tools with customTools bound to the worktree cwd', async () => {
    toolFactoryCalls.length = 0;
    capturedCreateOptions = null;
    const created = sessions.create({ prompt: 'override tools', provider: 'pi' });
    const worktreePath = '/tmp/nuncio-workspaces/override01';

    await provider.run(created.id, created.prompt, {
      emit: () => {},
      cwd: worktreePath,
    });

    const opts = capturedCreateOptions as {
      customTools?: unknown[];
    } | null;
    expect(opts?.customTools).toBeDefined();
    expect(opts?.customTools?.length).toBe(7);
    expect(toolFactoryCalls.length).toBe(7);
    for (const { cwd } of toolFactoryCalls) {
      expect(cwd).toBe(worktreePath);
    }
    expect(toolFactoryCalls.map((c) => c.kind).sort()).toEqual(
      ['bash', 'edit', 'find', 'grep', 'ls', 'read', 'write'].sort(),
    );
  });

  it('omits cwd, customTools, and tool factories when context.cwd is absent', async () => {
    inMemoryCalls.length = 0;
    toolFactoryCalls.length = 0;
    capturedCreateOptions = null;
    const created = sessions.create({ prompt: 'no workspace', provider: 'pi' });

    await provider.run(created.id, created.prompt, { emit: () => {} });

    const opts = capturedCreateOptions as {
      cwd?: string;
      customTools?: unknown[];
    } | null;
    expect(opts?.cwd).toBeUndefined();
    expect(inMemoryCalls).toContain(undefined);
    expect(opts?.customTools).toBeUndefined();
    expect(toolFactoryCalls).toHaveLength(0);
  });
});
