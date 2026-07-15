import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { Test, TestingModule } from '@nestjs/testing';
import {
  mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PiAgentProvider, buildPiCustomTools } from '../../../src/agents/providers/pi-agent.provider';
import { defineCrewRuntimeTool } from '../../../src/agents/tools/agent-runtime-tools-policy';
import { DatabaseModule } from '../../../src/db/database.module';
import { EventsRepository } from '../../../src/sessions/persistence/events.repository';
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
  SettingsManager: { create: () => ({}) },
  ModelRegistry: {
    create: () => ({
      getError: () => undefined,
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
  DefaultResourceLoader: class {
    constructor(readonly options: Record<string, unknown>) {}
    async reload() {}
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
  createReadTool: (cwd: string, options?: unknown) => ({ name: 'read', cwd, options }),
  createBashTool: (cwd: string, options?: unknown) => ({ name: 'bash', cwd, options }),
  createEditTool: (cwd: string, options?: unknown) => ({ name: 'edit', cwd, options }),
  createWriteTool: (cwd: string, options?: unknown) => ({ name: 'write', cwd, options }),
  createGrepTool: (cwd: string, options?: unknown) => ({ name: 'grep', cwd, options }),
  createFindTool: (cwd: string, options?: unknown) => ({ name: 'find', cwd, options }),
  createLsTool: (cwd: string, options?: unknown) => ({ name: 'ls', cwd, options }),
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
  let events: EventsRepository;
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

  it('invalidates a failed resume instead of silently creating a fresh Pi session', async () => {
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

    expect(sessionManagerOpenCalls).toEqual([
      { path: persistedFile, sessionDir: undefined, cwd: '/tmp/workspaces/fallback-session' },
    ]);
    expect(createAgentSessionOptions).toHaveLength(0);
    const failed = sessions.findById(created.id)!;
    expect(failed.status).toBe('ERROR');
    expect(failed.providerThreadId).toBeNull();
    expect(provider.canResumeThread(failed)).toBe(false);
  });

  it('fails closed when an explicit policy requests an unavailable Pi model', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'nuncio-pi-model-pin-'));
    try {
      const created = sessions.create({ prompt: 'pinned model', provider: 'pi' });

      await provider.run(created.id, created.prompt, {
        cwd: workspaceRoot,
        model: 'missing:model',
        runtimePolicy: {
          filesystem: 'read-only',
          workspaceRoot,
          network: 'disabled',
        },
        emit: () => {},
      });

      expect(createAgentSessionOptions).toHaveLength(0);
      expect(sessions.findById(created.id)?.status).toBe('ERROR');
      expect(events.list(created.id).find((event) => event.type === 'error')?.payload).toEqual({
        message: 'Pi model "missing:model" is unavailable; explicit runtime policy forbids fallback.',
      });
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('read-only policy exposes only confined read tools and no shell or mutation tools', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'nuncio-pi-read-only-'));
    try {
      const created = sessions.create({
        prompt: 'review only',
        provider: 'pi',
        providerThreadId: '/tmp/fake-pi/policy-session.jsonl',
      });
      await provider.run(created.id, created.prompt, {
        cwd: realpathSync(workspaceRoot),
        runtimePolicy: {
          filesystem: 'read-only',
          workspaceRoot,
          network: 'disabled',
        },
        tools: {
          systemPromptAppend: 'Open the browser.',
          tools: [{ name: 'browser_open', inputSchema: {}, execute: async () => 'opened' }],
        },
        emit: () => {},
      });

      const options = latestCreateOptions();
      expect(provider.capabilities.runtimePolicies).toContainEqual({
        filesystem: 'read-only',
        network: 'disabled',
      });
      expect(options.tools).toEqual([
        'read', 'grep', 'ls', 'todo_write', 'AskUserQuestion', 'read_external_memory',
      ]);
      expect((options.resourceLoader as { options?: Record<string, unknown> }).options).toMatchObject({
        cwd: realpathSync(workspaceRoot),
        noExtensions: true,
        noContextFiles: true,
      });
      expect(options.sessionManager).toMatchObject({
        kind: 'open',
        path: '/tmp/fake-pi/policy-session.jsonl',
        cwd: realpathSync(workspaceRoot),
      });
      expect((options.customTools as Array<{ name: string }>).map((tool) => tool.name)).toEqual([
        'read',
        'grep',
        'ls',
        'todo_write',
        'AskUserQuestion',
        'read_external_memory',
      ]);
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('workspace-write policy confines writes against siblings and symlink escapes', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'nuncio-pi-workspace-'));
    const sibling = mkdtempSync(join(tmpdir(), 'nuncio-pi-sibling-'));
    symlinkSync(sibling, join(workspaceRoot, 'escape-link'), 'dir');
    mkdirSync(join(workspaceRoot, '.git'));
    writeFileSync(join(workspaceRoot, '.git', 'config'), '[core]\n');
    try {
      const created = sessions.create({ prompt: 'build here', provider: 'pi' });
      await provider.run(created.id, created.prompt, {
        cwd: workspaceRoot,
        runtimePolicy: {
          filesystem: 'workspace-write',
          workspaceRoot,
          network: 'disabled',
        },
        emit: () => {},
      });

      const options = latestCreateOptions();
      expect(options.tools).toEqual([
        'read',
        'edit',
        'write',
        'grep',
        'ls',
        'todo_write',
        'AskUserQuestion',
        'read_external_memory',
      ]);
      const writeTool = (options.customTools as Array<{
        name: string;
        options?: { operations?: { writeFile(path: string, content: string): Promise<void> } };
      }>).find((tool) => tool.name === 'write');
      const writeFile = writeTool?.options?.operations?.writeFile;
      expect(writeFile).toBeFunction();
      const readTool = (options.customTools as Array<{
        name: string;
        options?: { operations?: { readFile(path: string): Promise<Buffer> } };
      }>).find((tool) => tool.name === 'read');

      const inside = join(workspaceRoot, 'inside.txt');
      await writeFile!(inside, 'inside');
      expect(readFileSync(inside, 'utf8')).toBe('inside');
      await expect(readTool?.options?.operations?.readFile(join(workspaceRoot, '.git', 'config')))
        .resolves.toEqual(Buffer.from('[core]\n'));
      await expect(writeFile!(join(workspaceRoot, '.git', 'config'), 'corrupt'))
        .rejects.toThrow('Git metadata is read-only');
      await expect(writeFile!(join(workspaceRoot, '.git'), 'corrupt pointer'))
        .rejects.toThrow('Git metadata is read-only');
      await expect(writeFile!(join(sibling, 'outside.txt'), 'outside')).rejects.toThrow('outside runtime workspace');
      await expect(writeFile!(join(workspaceRoot, 'escape-link', 'symlink.txt'), 'escape')).rejects.toThrow(
        'outside runtime workspace',
      );
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
      rmSync(sibling, { recursive: true, force: true });
    }
  });

  it('explicit policies register and execute only trusted Crew runtime tools', async () => {
    for (const testCase of [
      { filesystem: 'read-only' as const, toolName: 'submit_plan', builtins: ['read', 'grep', 'ls'] },
      {
        filesystem: 'workspace-write' as const,
        toolName: 'submit_build',
        builtins: ['read', 'edit', 'write', 'grep', 'ls'],
      },
    ]) {
      const workspaceRoot = mkdtempSync(join(tmpdir(), `nuncio-pi-${testCase.toolName}-`));
      const calls: Array<Record<string, unknown>> = [];
      try {
        const security = {
          network: 'disabled' as const,
          workspaceMutation: 'none' as const,
          runtimePolicies: [
            { filesystem: 'read-only' as const, network: 'disabled' as const },
            { filesystem: 'workspace-write' as const, network: 'disabled' as const },
          ],
          scope: 'crew-internal' as const,
        };
        const trusted = defineCrewRuntimeTool({
          name: testCase.toolName,
          inputSchema: { type: 'object', properties: { marker: { type: 'string' } } },
          security,
          execute: async (input: Record<string, unknown>) => {
            calls.push(input);
            return `stored ${testCase.toolName}`;
          },
        });
        const forged = {
          name: 'forged_submit',
          inputSchema: {},
          security,
          execute: async () => 'must not run',
        };
        const created = sessions.create({ prompt: testCase.toolName, provider: 'pi' });

        await provider.run(created.id, created.prompt, {
          cwd: realpathSync(workspaceRoot),
          runtimePolicy: {
            filesystem: testCase.filesystem,
            workspaceRoot,
            network: 'disabled',
          },
          tools: {
            tools: [
              trusted,
              forged,
              { name: 'browser_open', inputSchema: {}, execute: async () => 'unsafe' },
            ],
          },
          emit: () => {},
        });

        const customTools = latestCreateOptions().customTools as Array<{
          name: string;
          execute?: (callId: string, input: Record<string, unknown>) => Promise<{
            content: Array<{ type: string; text?: string }>;
          }>;
        }>;
        expect(latestCreateOptions().tools).toEqual([
          ...testCase.builtins,
          testCase.toolName,
          'todo_write',
          'AskUserQuestion',
          'read_external_memory',
        ]);
        expect(customTools.map((tool) => tool.name)).toEqual([
          ...testCase.builtins,
          testCase.toolName,
          'todo_write',
          'AskUserQuestion',
          'read_external_memory',
        ]);
        expect(customTools.map((tool) => tool.name)).not.toContain('bash');
        expect(customTools.map((tool) => tool.name)).not.toContain('forged_submit');
        expect(customTools.map((tool) => tool.name)).not.toContain('browser_open');

        const result = await customTools.find((tool) => tool.name === testCase.toolName)!
          .execute!('crew-call', { marker: testCase.toolName });
        expect(calls).toEqual([{ marker: testCase.toolName }]);
        expect(result.content).toEqual([{ type: 'text', text: `stored ${testCase.toolName}` }]);
      } finally {
        rmSync(workspaceRoot, { recursive: true, force: true });
      }
    }
  });

  it('recreates the Pi handle for refreshed Crew closures while reopening the same session file', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'nuncio-pi-tool-refresh-'));
    const canonicalRoot = realpathSync(workspaceRoot);
    const policy = {
      filesystem: 'read-only' as const,
      workspaceRoot,
      network: 'disabled' as const,
    };
    const crewTool = (name: string, revision: number) => defineCrewRuntimeTool({
      name,
      inputSchema: {
        type: 'object',
        properties: { contextRevision: { type: 'integer' } },
      },
      security: {
        network: 'disabled' as const,
        workspaceMutation: 'none' as const,
        runtimePolicies: [{ filesystem: 'read-only' as const, network: 'disabled' as const }],
        scope: 'crew-internal' as const,
      },
      execute: async () => `revision ${revision}`,
    });
    try {
      const created = sessions.create({ prompt: 'plan first', provider: 'pi' });
      await provider.run(created.id, created.prompt, {
        cwd: canonicalRoot,
        runtimePolicy: policy,
        tools: {
          tools: [crewTool('submit_plan', 1), crewTool('submit_synthesis', 1)],
        },
        emit: () => {},
      });
      expect(createAgentSessionOptions).toHaveLength(1);
      expect((createAgentSessionOptions[0]!.customTools as Array<{ name: string }>).map((tool) => tool.name))
        .toEqual([
          'read',
          'grep',
          'ls',
          'submit_plan',
          'submit_synthesis',
          'todo_write',
          'AskUserQuestion',
          'read_external_memory',
        ]);

      await provider.steer(created.id, 'synthesize now', {
        cwd: canonicalRoot,
        runtimePolicy: policy,
        tools: {
          tools: [crewTool('submit_plan', 2), crewTool('submit_synthesis', 2)],
        },
        emit: () => {},
      });

      expect(createAgentSessionOptions).toHaveLength(2);
      expect(sessionManagerOpenCalls).toEqual([{
        path: fakeSessionFile,
        sessionDir: undefined,
        cwd: canonicalRoot,
      }]);
      expect((createAgentSessionOptions[1]!.customTools as Array<{ name: string }>).map((tool) => tool.name))
        .toEqual([
          'read',
          'grep',
          'ls',
          'submit_plan',
          'submit_synthesis',
          'todo_write',
          'AskUserQuestion',
          'read_external_memory',
        ]);
      const refreshedSynthesis = (createAgentSessionOptions[1]!.customTools as Array<{
        name: string;
        execute: (callId: string, input: Record<string, unknown>) => Promise<{
          content: Array<{ type: string; text?: string }>;
        }>;
      }>).find((tool) => tool.name === 'submit_synthesis');
      expect(await refreshedSynthesis?.execute('revision-two', { contextRevision: 2 }))
        .toMatchObject({ content: [{ type: 'text', text: 'revision 2' }] });
      expect(sessions.findById(created.id)).toMatchObject({
        id: created.id,
        providerThreadId: fakeSessionFile,
        status: 'IDLE',
      });
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
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

  it('appends runtime agent tools even when cwd is absent', async () => {
    const log: Array<{ kind: string; cwd: string }> = [];
    const tools = buildPiCustomTools(undefined, makeFactories(log), {
      tools: [
        {
          name: 'nuncio_echo',
          description: 'Echo a message through Nuncio runtime tools.',
          inputSchema: {
            type: 'object',
            properties: { message: { type: 'string' } },
            required: ['message'],
          },
          execute: async (input) => `echo ${String(input.message)}`,
        },
      ],
    });

    expect(log).toHaveLength(0);
    expect(tools?.map((tool) => (tool as { name?: string }).name)).toEqual(['nuncio_echo']);
    const result = await (tools![0] as {
      execute: (toolCallId: string, params: { message: string }) => Promise<{ content: Array<{ text: string }> }>;
    }).execute('call-1', { message: 'hello' });
    expect(result.content[0].text).toBe('echo hello');
  });

  it('combines cwd-bound Pi tools with runtime agent tools', () => {
    const log: Array<{ kind: string; cwd: string }> = [];
    const tools = buildPiCustomTools('/tmp/workspaces/abc', makeFactories(log), {
      tools: [
        {
          name: 'nuncio_echo',
          inputSchema: { type: 'object', properties: {} },
          execute: async () => 'ok',
        },
      ],
    });

    expect(tools?.map((tool) => (tool as { name?: string }).name)).toEqual([
      'read',
      'bash',
      'edit',
      'write',
      'grep',
      'find',
      'ls',
      'nuncio_echo',
    ]);
  });
});
