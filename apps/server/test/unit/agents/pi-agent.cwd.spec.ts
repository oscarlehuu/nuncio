import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { Test, TestingModule } from '@nestjs/testing';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PiAgentProvider, buildPiCustomTools } from '../../../src/agents/providers/pi-agent.provider';
import { DatabaseModule } from '../../../src/db/database.module';
import { SessionsRepository } from '../../../src/sessions/persistence/sessions.repository';
import { SessionsPersistenceModule } from '../../../src/sessions/sessions.persistence.module';
import { SettingsModule } from '../../../src/settings/settings.module';

// Unit tests for the Pi cwd/session-manager wiring. The provider is exercised
// with a tiny SDK stub injected into its lazy SDK promise — no real Pi SDK, auth,
// or module-level mocking required. End-to-end behavior with real Pi is covered
// by pi-agent.integration.spec.ts (gated on ~/.pi/agent/auth.json).

type CreateAgentSessionOptions = Record<string, unknown>;

type OpenCall = { path: string; sessionDir: undefined; cwd?: string };

let createAgentSessionOptions: CreateAgentSessionOptions[] = [];
let sessionManagerOpenCalls: OpenCall[] = [];
let sessionManagerOpenShouldThrow = false;
let fakeSessionFile = '/tmp/fake-pi/session.jsonl';

const makePiSdkStub = () => ({
  AuthStorage: { create: () => ({}) },
  ModelRegistry: {
    create: () => ({
      getAvailable: () => [],
      getProviderDisplayName: (provider: string) => provider,
      find: () => undefined,
    }),
  },
  SessionManager: {
    open: (path: string, sessionDir: undefined, cwd?: string) => {
      sessionManagerOpenCalls.push({ path, sessionDir, cwd });
      if (sessionManagerOpenShouldThrow) throw new Error('cannot open persisted Pi session');
      return { kind: 'open', path, sessionDir, cwd };
    },
  },
  createAgentSession: (options: CreateAgentSessionOptions) => {
    createAgentSessionOptions.push(options);
    return {
      session: {
        sessionFile: fakeSessionFile,
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
  (provider as unknown as { piSdkPromise: Promise<unknown> }).piSdkPromise = Promise.resolve(makePiSdkStub());
}

function latestCreateOptions(): CreateAgentSessionOptions {
  const options = createAgentSessionOptions.at(-1);
  if (!options) throw new Error('createAgentSession was not called');
  return options;
}

describe('PiAgentProvider cwd/session-manager wiring', () => {
  let module: TestingModule;
  let provider: PiAgentProvider;
  let sessions: SessionsRepository;
  let dataDir: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-pi-cwd-'));
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
  });

  beforeEach(() => {
    createAgentSessionOptions = [];
    sessionManagerOpenCalls = [];
    sessionManagerOpenShouldThrow = false;
    fakeSessionFile = '/tmp/fake-pi/session.jsonl';
    process.env.PI_AGENT_DIR = '/tmp/custom-pi-agent';
    injectPiSdkStub(provider);
  });

  it('omits sessionManager for a new session while passing the configured agentDir', async () => {
    const created = sessions.create({ prompt: 'new Pi session', provider: 'pi' });

    await provider.run(created.id, created.prompt, {
      cwd: '/tmp/workspaces/new-session',
      emit: () => {},
    });

    const options = latestCreateOptions();
    expect(options.agentDir).toBe('/tmp/custom-pi-agent');
    expect(options.cwd).toBe('/tmp/workspaces/new-session');
    expect('sessionManager' in options).toBe(false);
    expect(sessionManagerOpenCalls).toEqual([]);
  });

  it('passes a resume manager opened from the persisted Pi session file', async () => {
    const persistedFile = '/tmp/custom-pi-agent/sessions/persisted.jsonl';
    fakeSessionFile = persistedFile;
    const created = sessions.create({
      prompt: 'resume Pi session',
      provider: 'pi',
      providerThreadId: persistedFile,
    });

    await provider.run(created.id, created.prompt, {
      cwd: '/tmp/workspaces/resume-session',
      emit: () => {},
    });

    const options = latestCreateOptions();
    expect(sessionManagerOpenCalls).toEqual([
      { path: persistedFile, sessionDir: undefined, cwd: '/tmp/workspaces/resume-session' },
    ]);
    expect(options.sessionManager).toEqual({
      kind: 'open',
      path: persistedFile,
      sessionDir: undefined,
      cwd: '/tmp/workspaces/resume-session',
    });
  });

  it('falls back to a fresh SDK-created session when opening the persisted file fails', async () => {
    sessionManagerOpenShouldThrow = true;
    const persistedFile = '/tmp/custom-pi-agent/sessions/missing.jsonl';
    const created = sessions.create({
      prompt: 'fallback Pi session',
      provider: 'pi',
      providerThreadId: persistedFile,
    });

    await provider.run(created.id, created.prompt, {
      cwd: '/tmp/workspaces/fallback-session',
      emit: () => {},
    });

    const options = latestCreateOptions();
    expect(sessionManagerOpenCalls).toEqual([
      { path: persistedFile, sessionDir: undefined, cwd: '/tmp/workspaces/fallback-session' },
    ]);
    expect('sessionManager' in options).toBe(false);
  });
});

describe('buildPiCustomTools', () => {
  const makeFactories = (log: Array<{ kind: string; cwd: string }>) => ({
    createReadTool: (cwd: string) => { log.push({ kind: 'read', cwd }); return { name: 'read' }; },
    createBashTool: (cwd: string) => { log.push({ kind: 'bash', cwd }); return { name: 'bash' }; },
    createEditTool: (cwd: string) => { log.push({ kind: 'edit', cwd }); return { name: 'edit' }; },
    createWriteTool: (cwd: string) => { log.push({ kind: 'write', cwd }); return { name: 'write' }; },
    createGrepTool: (cwd: string) => { log.push({ kind: 'grep', cwd }); return { name: 'grep' }; },
    createFindTool: (cwd: string) => { log.push({ kind: 'find', cwd }); return { name: 'find' }; },
    createLsTool: (cwd: string) => { log.push({ kind: 'ls', cwd }); return { name: 'ls' }; },
  });

  it('returns all 7 built-in tools bound to the worktree cwd when cwd is set', () => {
    const log: Array<{ kind: string; cwd: string }> = [];
    const tools = buildPiCustomTools('/tmp/workspaces/abc', makeFactories(log));

    expect(tools).toBeDefined();
    expect(tools?.length).toBe(7);
    expect(log.length).toBe(7);
    for (const { cwd } of log) {
      expect(cwd).toBe('/tmp/workspaces/abc');
    }
    expect(log.map((e) => e.kind).sort()).toEqual(
      ['bash', 'edit', 'find', 'grep', 'ls', 'read', 'write'].sort(),
    );
  });

  it('returns undefined and calls no factories when cwd is absent', () => {
    const log: Array<{ kind: string; cwd: string }> = [];
    const tools = buildPiCustomTools(undefined, makeFactories(log));

    expect(tools).toBeUndefined();
    expect(log).toHaveLength(0);
  });
});
