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
} | null = null;

const inMemoryCalls: Array<string | undefined> = [];

// Stub the Pi SDK so createAgentSession never makes a real LLM call.
// Captures the options the provider assembles (cwd + sessionManager) for assertion.
mock.module('@earendil-works/pi-coding-agent', () => ({
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
  createAgentSession: async (options: {
    cwd?: string;
    sessionManager?: unknown;
    tools?: string[];
  }) => {
    capturedCreateOptions = options;
    const session = {
      subscribe: () => () => {},
      prompt: async () => {},
    };
    return { session };
  },
}));

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

  it('omits cwd and uses SessionManager.inMemory() with no argument when context.cwd is absent', async () => {
    inMemoryCalls.length = 0;
    capturedCreateOptions = null;
    const created = sessions.create({ prompt: 'no workspace', provider: 'pi' });

    await provider.run(created.id, created.prompt, { emit: () => {} });

    const opts = capturedCreateOptions as { cwd?: string; sessionManager?: unknown; tools?: string[] } | null;
    expect(opts?.cwd).toBeUndefined();
    expect(inMemoryCalls).toContain(undefined);
  });
});
