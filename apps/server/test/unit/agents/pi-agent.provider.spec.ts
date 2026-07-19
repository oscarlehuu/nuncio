import { beforeAll, afterAll, beforeEach, describe, it, expect, mock } from 'bun:test';
import { Test, TestingModule } from '@nestjs/testing';
import { configurePiSdkMock } from './pi-sdk.mock';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PiAgentProvider } from '../../../src/agents/providers/pi-agent.provider';
import {
  buildAgentRuntimeEnvironment,
  createNuncioRuntimeInfoTool,
} from '../../../src/agents/runtime-environment';
import { DatabaseModule } from '../../../src/db/database.module';
import { SessionsRepository } from '../../../src/sessions/persistence/sessions.repository';
import { EventsRepository } from '../../../src/sessions/persistence/events.repository';
import { SessionsPersistenceModule } from '../../../src/sessions/sessions.persistence.module';
import { SettingsModule } from '../../../src/settings/settings.module';
import { SettingsService } from '../../../src/settings/settings.service';
import { ContextModule } from '../../../src/context/context.module';
import { ContextFactsRepository } from '../../../src/context/context-facts.repository';
import {
  NuncioContextRepository,
  NuncioContextService,
} from '../../../src/agents/pi-engine/nuncio-context';
import { TasksRepository } from '../../../src/tasks/tasks.repository';
import {
  ExternalMemorySources,
  parseCodexMemoryIndex,
} from '../../../src/agents/pi-engine/external-memory-sources';
import { ExternalMemoriesService } from '../../../src/agents/pi-engine/external-memories';

let availableModelCount = 0;
let fakeSessionFile = '/tmp/fake-pi/session.jsonl';
let promptCalls: Array<{ text: string; options: unknown }> = [];
let promptBehavior: ((text: string, options?: unknown) => Promise<void>) | null = null;
let isStreaming = false;
let subscribedHandler: ((event: { type: string; [key: string]: unknown }) => void) | null = null;
let sessionOpenError: Error | null = null;
let createSessionCalls = 0;
let customRegistryModels = new Map<string, ReturnType<typeof registryModel>>();
let lastModelsPath: string | undefined;
const abortMock = mock(async () => undefined);
const steerMock = mock(async (_text: string, _images?: unknown) => undefined);
const setModelMock = mock(async (_model: unknown) => undefined);
const setThinkingLevelMock = mock((_level: unknown) => undefined);

function registryModel(provider = 'anthropic', id = 'model-1'): {
  provider: string;
  id: string;
  name: string;
  reasoning: boolean;
  thinkingLevelMap: Record<string, string | null>;
} {
  return {
    provider,
    id,
    name: `Model ${id}`,
    reasoning: true,
    thinkingLevelMap: { off: null, low: 'low', medium: 'medium', high: 'high', max: 'max' },
  };
}

let lastCreateSessionOptions: Record<string, unknown> | null = null;
let lastLoaderOptions: Record<string, unknown> | null = null;
let loaderReloadCalls = 0;

configurePiSdkMock({
  AuthStorage: { create: () => ({}) },
  SettingsManager: { create: () => ({ kind: 'settings-manager' }) },
  DefaultResourceLoader: class {
    constructor(options: Record<string, unknown>) {
      lastLoaderOptions = options;
    }
    async reload() {
      loaderReloadCalls += 1;
    }
  },
  defineTool: (tool: unknown) => tool,
  createReadTool: () => ({ name: 'read' }),
  createBashTool: () => ({ name: 'bash' }),
  createEditTool: () => ({ name: 'edit' }),
  createWriteTool: () => ({ name: 'write' }),
  createGrepTool: () => ({ name: 'grep' }),
  createFindTool: () => ({ name: 'find' }),
  createLsTool: () => ({ name: 'ls' }),
  ModelRegistry: {
    create: (_authStorage: unknown, modelsPath?: string) => {
      lastModelsPath = modelsPath;
      return {
      getError: () => undefined,
      getAvailable: () => Array.from({ length: availableModelCount }, (_, i) => ({
        provider: 'anthropic',
        id: `model-${i}`,
        name: `Model ${i}`,
      })),
      getProviderDisplayName: (provider: string) => provider,
      find: (provider: string, id: string) => provider === 'anthropic'
        ? registryModel(provider, id)
        : customRegistryModels.get(`${provider}:${id}`),
      };
    },
  },
  SessionManager: {
    open: (path: string, sessionDir: undefined, cwd?: string) => {
      if (sessionOpenError) throw sessionOpenError;
      return { kind: 'open', path, sessionDir, cwd };
    },
  },
  createAgentSession: (options: Record<string, unknown>) => {
    createSessionCalls += 1;
    lastCreateSessionOptions = options;
    return {
      session: {
        sessionFile: fakeSessionFile,
        get model() {
          return registryModel();
        },
        get thinkingLevel() {
          return 'medium';
        },
        get isStreaming() {
          return isStreaming;
        },
        subscribe: (handler: (event: { type: string; [key: string]: unknown }) => void) => {
          subscribedHandler = handler;
          return () => {
            if (subscribedHandler === handler) subscribedHandler = null;
          };
        },
        prompt: async (text: string, options?: unknown) => {
          promptCalls.push({ text, options });
          await promptBehavior?.(text, options);
        },
        abort: abortMock,
        steer: steerMock,
        setModel: setModelMock,
        setThinkingLevel: setThinkingLevelMock,
      },
    };
  },
  getAgentDir: () => '/tmp/fake-pi',
});

describe('PiAgentProvider', () => {
  let module: TestingModule;
  let provider: PiAgentProvider;
  let sessions: SessionsRepository;
  let events: EventsRepository;
  let settings: SettingsService;
  let contextFacts: ContextFactsRepository;
  let tasks: TasksRepository;
  let dataDir: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-pi-provider-'));
    process.env.NUNCIO_DATA_DIR = dataDir;

    module = await Test.createTestingModule({
      imports: [DatabaseModule, SessionsPersistenceModule, SettingsModule, ContextModule],
      providers: [
        PiAgentProvider,
        NuncioContextRepository,
        NuncioContextService,
        ExternalMemorySources,
        ExternalMemoriesService,
        TasksRepository,
      ],
    }).compile();

    provider = module.get(PiAgentProvider);
    sessions = module.get(SessionsRepository);
    events = module.get(EventsRepository);
    settings = module.get(SettingsService);
    contextFacts = module.get(ContextFactsRepository);
    tasks = module.get(TasksRepository);
  });

  afterAll(async () => {
    await module.close();
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.NUNCIO_DATA_DIR;
  });

  beforeEach(() => {
    // Keep provider tests hermetic; dedicated cases opt into fixture-backed stores.
    settings.set('PI_EXTERNAL_MEMORIES', 'off');
    availableModelCount = 0;
    fakeSessionFile = '/tmp/fake-pi/session.jsonl';
    promptCalls = [];
    promptBehavior = null;
    isStreaming = false;
    subscribedHandler = null;
    lastCreateSessionOptions = null;
    lastLoaderOptions = null;
    loaderReloadCalls = 0;
    sessionOpenError = null;
    createSessionCalls = 0;
    customRegistryModels = new Map();
    lastModelsPath = undefined;
    abortMock.mockClear();
    steerMock.mockClear();
    setModelMock.mockClear();
    setThinkingLevelMock.mockClear();
    provider.bustCache();
  });

  it('declares Pi live-switch and image capabilities', () => {
    expect(provider.capabilities).toEqual({
      interrupt: true,
      modelSwitch: 'in-session',
      effortSwitch: 'in-session',
      images: true,
      steerWhileRunning: true,
      spawnTask: true,
      reproduceGate: true,
      modes: ['debug', 'multitask'],
      runtimePolicies: [
        { filesystem: 'read-only', network: 'disabled' },
        { filesystem: 'workspace-write', network: 'disabled' },
      ],
    });
  });

  it('is unavailable when the Pi registry has no models', async () => {
    expect(await provider.isAvailable()).toBe(false);
  });

  it('is available when the Pi registry reports models', async () => {
    availableModelCount = 1;
    provider.bustCache();
    expect(await provider.isAvailable()).toBe(true);
  });

  it('loads only allowlisted pi extensions through an engine resource loader', async () => {
    const created = sessions.create({ prompt: 'allowlist probe', provider: 'pi' });
    await provider.run(created.id, created.prompt, { emit: () => {} });

    expect(loaderReloadCalls).toBe(1);
    expect(lastCreateSessionOptions?.resourceLoader).toBeDefined();
    expect(lastCreateSessionOptions?.settingsManager).toEqual({ kind: 'settings-manager' });
    expect(lastLoaderOptions?.noExtensions).toBe(true);
    const paths = lastLoaderOptions?.additionalExtensionPaths as string[];
    expect(paths).toContain('/tmp/fake-pi/extensions/foreman');
    expect(paths.some((p) => p.includes('claude-studio'))).toBe(false);
  });

  it('creates optional custom-provider Opus sessions with xhigh and max effort', async () => {
    const originalResolve = settings.resolve.bind(settings);
    settings.resolve = ((key: string) => key === 'NUNCIO_PI_MODELS_PATH'
      ? '/tmp/user-config/models.json'
      : originalResolve(key)) as SettingsService['resolve'];
    customRegistryModels.set(
      'custom-proxy:claude-opus-4-8',
      {
        ...registryModel('custom-proxy', 'claude-opus-4-8'),
        thinkingLevelMap: { xhigh: 'xhigh', max: 'max' },
      },
    );

    try {
      for (const thinkingLevel of ['xhigh', 'max'] as const) {
        const created = sessions.create({
          prompt: `opus ${thinkingLevel}`,
          provider: 'pi',
          model: 'custom-proxy:claude-opus-4-8',
          modelOptions: { thinkingLevel },
        });

        await provider.run(created.id, created.prompt, {
          emit: () => {},
          model: created.model ?? undefined,
          modelOptions: created.modelOptions ?? undefined,
        });

        expect(lastCreateSessionOptions?.model).toMatchObject({
          provider: 'custom-proxy',
          id: 'claude-opus-4-8',
        });
        expect(lastCreateSessionOptions?.thinkingLevel).toBe(thinkingLevel);
        expect(lastModelsPath).toBe('/tmp/user-config/models.json');
      }
    } finally {
      settings.resolve = originalResolve as SettingsService['resolve'];
    }
  });

  it('appends project facts and prefers the current Solo session brief', async () => {
    const projectPath = `/tmp/nuncio-context-${Date.now()}`;
    contextFacts.upsert({
      projectPath,
      key: 'runtime',
      value: 'Use Bun for all commands.',
      provenance: 'founder',
    });
    tasks.create({
      prompt: 'older task',
      projectPath,
      contextBrief: { goal: 'Ignore the older brief.' },
    });
    const ownTask = tasks.create({
      prompt: 'current session task',
      projectPath,
      contextBrief: { goal: 'Honor the current session brief.' },
    });
    const created = sessions.create({
      prompt: 'context probe',
      provider: 'pi',
      projectPath,
      originTaskId: ownTask.id,
    });
    tasks.create({
      prompt: 'newer unrelated task',
      projectPath,
      contextBrief: { goal: 'Ignore the newer unrelated brief.' },
    });
    tasks.create({
      prompt: 'newer crew task',
      projectPath,
      contextBrief: { goal: 'Ignore the Crew member brief.' },
      executionKind: 'crew-member',
      crewRunId: 'crew-run-context',
      crewMemberKey: 'builder:primary',
    });
    const cancelled = tasks.create({
      prompt: 'newer cancelled task',
      projectPath,
      contextBrief: { goal: 'Ignore the cancelled brief.' },
    });
    tasks.cancel(cancelled.id);

    await provider.run(created.id, created.prompt, { emit: () => {} });

    const appended = lastLoaderOptions?.appendSystemPrompt as string[];
    expect(appended).toHaveLength(1);
    expect(appended[0]!.startsWith('## Nuncio project context')).toBe(true);
    expect(appended[0]!.indexOf('**runtime**')).toBeLessThan(
      appended[0]!.indexOf('## Handoff brief'),
    );
    expect(appended[0]).toContain('Honor the current session brief.');
    expect(appended[0]).not.toContain('Ignore the older brief.');
    expect(appended[0]).not.toContain('Ignore the newer unrelated brief.');
    expect(appended[0]).not.toContain('Ignore the Crew member brief.');
    expect(appended[0]).not.toContain('Ignore the cancelled brief.');
  });

  it('omits appendSystemPrompt when the project has no facts', async () => {
    const projectPath = `/tmp/nuncio-context-empty-${Date.now()}`;
    tasks.create({
      prompt: 'brief without facts',
      projectPath,
      contextBrief: { goal: 'A brief alone must not emit scaffolding.' },
    });
    const created = sessions.create({ prompt: 'empty context probe', provider: 'pi', projectPath });

    await provider.run(created.id, created.prompt, { emit: () => {} });

    expect(lastLoaderOptions?.appendSystemPrompt).toBeUndefined();
  });

  it('injects the debug-mode overlay through the system-prompt seam', async () => {
    const created = sessions.create({ prompt: 'find the bug', provider: 'pi', mode: 'debug' });

    await provider.run(created.id, created.prompt, { emit: () => {}, mode: 'debug' });

    const appended = (lastLoaderOptions?.appendSystemPrompt as string[] | undefined)?.[0] ?? '';
    expect(appended).toContain('Debug mode');
    expect(appended).toContain('// nuncio-debug');
  });

  it('injects no mode overlay for a normal session', async () => {
    const created = sessions.create({ prompt: 'just run', provider: 'pi' });

    await provider.run(created.id, created.prompt, { emit: () => {} });

    const appended = (lastLoaderOptions?.appendSystemPrompt as string[] | undefined)?.[0] ?? '';
    expect(appended).not.toContain('Debug mode');
    expect(appended).not.toContain('Multitask mode');
  });

  it('composes project context, external memories, then runtime instructions', async () => {
    const projectPath = `/tmp/nuncio-external-${Date.now()}`;
    const codexHome = mkdtempSync(join(tmpdir(), 'nuncio-codex-memory-'));
    mkdirSync(join(codexHome, 'memories'));
    writeFileSync(join(codexHome, 'memories', 'MEMORY.md'), [
      '# Task Group: Engine memory work',
      'scope: external memory implementation',
      `applies_to: cwd=${projectPath}; reuse_rule=safe`,
      '',
      '## Reusable knowledge',
      'Keep source stores read-only.',
    ].join('\n'));
    contextFacts.upsert({
      projectPath,
      key: 'runtime',
      value: 'Use Bun.',
      provenance: 'founder',
    });
    const created = sessions.create({ prompt: 'memory probe', provider: 'pi', projectPath });
    const runtimeEnvironment = buildAgentRuntimeEnvironment({
      sessionId: created.id,
      provider: 'pi',
      model: null,
      projectPath,
      cwd: projectPath,
      supportsInteraction: true,
      runtimeTools: { tools: [] },
    });
    const originalResolve = settings.resolve.bind(settings);
    settings.resolve = ((key: string) => {
      if (key === 'PI_EXTERNAL_MEMORIES') return 'codex';
      if (key === 'NUNCIO_CODEX_HOME') return codexHome;
      return originalResolve(key);
    }) as SettingsService['resolve'];

    try {
      await provider.run(created.id, created.prompt, { emit: () => {}, runtimeEnvironment });
      const appended = (lastLoaderOptions?.appendSystemPrompt as string[])[0]!;
      expect(appended).toContain('## External agent memories');
      expect(appended.indexOf('## Nuncio project context')).toBeLessThan(
        appended.indexOf('## External agent memories'),
      );
      expect(appended.indexOf('## External agent memories')).toBeLessThan(
        appended.indexOf('running inside Nuncio'),
      );
    } finally {
      settings.resolve = originalResolve as SettingsService['resolve'];
      rmSync(codexHome, { recursive: true, force: true });
    }
  });

  it('honors a zero index budget by suppressing the external-memory index', async () => {
    const projectPath = `/tmp/nuncio-external-zero-${Date.now()}`;
    const codexHome = mkdtempSync(join(tmpdir(), 'nuncio-codex-memory-'));
    mkdirSync(join(codexHome, 'memories'));
    writeFileSync(join(codexHome, 'memories', 'MEMORY.md'), [
      '# Task Group: Engine memory work',
      'scope: external memory implementation',
      `applies_to: cwd=${projectPath}; reuse_rule=safe`,
    ].join('\n'));
    const created = sessions.create({ prompt: 'zero budget probe', provider: 'pi', projectPath });
    const originalResolve = settings.resolve.bind(settings);
    settings.resolve = ((key: string) => {
      if (key === 'PI_EXTERNAL_MEMORIES') return 'codex';
      if (key === 'PI_EXTERNAL_MEMORIES_MAX_BYTES') return '0';
      if (key === 'NUNCIO_CODEX_HOME') return codexHome;
      return originalResolve(key);
    }) as SettingsService['resolve'];

    try {
      await provider.run(created.id, created.prompt, { emit: () => {} });
      const appended = (lastLoaderOptions?.appendSystemPrompt as string[] | undefined)?.[0] ?? '';
      expect(appended).not.toContain('## External agent memories');
    } finally {
      settings.resolve = originalResolve as SettingsService['resolve'];
      rmSync(codexHome, { recursive: true, force: true });
    }
  });

  it('falls back to the inherited CODEX_HOME env for the Codex memory store', async () => {
    const projectPath = `/tmp/nuncio-external-env-${Date.now()}`;
    const codexHome = mkdtempSync(join(tmpdir(), 'nuncio-codex-env-'));
    mkdirSync(join(codexHome, 'memories'));
    writeFileSync(join(codexHome, 'memories', 'MEMORY.md'), [
      '# Task Group: Env store work',
      'scope: env-resolved store',
      `applies_to: cwd=${projectPath}; reuse_rule=safe`,
    ].join('\n'));
    const created = sessions.create({ prompt: 'env home probe', provider: 'pi', projectPath });
    const originalResolve = settings.resolve.bind(settings);
    settings.resolve = ((key: string) => {
      if (key === 'PI_EXTERNAL_MEMORIES') return 'codex';
      // A blank stored root must behave like unset and fall through to CODEX_HOME.
      if (key === 'NUNCIO_CODEX_HOME') return '  ';
      return originalResolve(key);
    }) as SettingsService['resolve'];
    const originalEnvHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = codexHome;

    try {
      await provider.run(created.id, created.prompt, { emit: () => {} });
      const appended = (lastLoaderOptions?.appendSystemPrompt as string[])[0]!;
      expect(appended).toContain('Env store work');
    } finally {
      settings.resolve = originalResolve as SettingsService['resolve'];
      if (originalEnvHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = originalEnvHome;
      rmSync(codexHome, { recursive: true, force: true });
    }
  });

  it('omits external memories when the Nuncio Engine setting is off', async () => {
    const originalResolve = settings.resolve.bind(settings);
    settings.resolve = ((key: string) => key === 'PI_EXTERNAL_MEMORIES'
      ? 'off'
      : originalResolve(key)) as SettingsService['resolve'];
    const created = sessions.create({
      prompt: 'disabled external memories',
      provider: 'pi',
      projectPath: '/tmp/disabled-external-memory',
    });

    try {
      await provider.run(created.id, created.prompt, { emit: () => {} });
      expect(lastLoaderOptions?.appendSystemPrompt).toBeUndefined();
    } finally {
      settings.resolve = originalResolve as SettingsService['resolve'];
    }
  });

  it('binds read_external_memory authorization to the index injected for the session', async () => {
    const projectPath = `/tmp/nuncio-external-snapshot-${Date.now()}`;
    const codexHome = mkdtempSync(join(tmpdir(), 'nuncio-codex-snapshot-'));
    const memoryDir = join(codexHome, 'memories');
    mkdirSync(memoryDir);
    const oldSection = [
      '# Task Group: Existing memory',
      'scope: original group',
      `applies_to: cwd=${projectPath}; reuse_rule=safe`,
      '',
      '## Reusable knowledge',
      'Original content.',
    ].join('\n');
    writeFileSync(join(memoryDir, 'MEMORY.md'), oldSection);
    const oldId = parseCodexMemoryIndex(oldSection)[0]!.id;
    const originalResolve = settings.resolve.bind(settings);
    settings.resolve = ((key: string) => {
      if (key === 'PI_EXTERNAL_MEMORIES') return 'codex';
      if (key === 'NUNCIO_CODEX_HOME') return codexHome;
      return originalResolve(key);
    }) as SettingsService['resolve'];
    const created = sessions.create({ prompt: 'snapshot memories', provider: 'pi', projectPath });

    try {
      await provider.run(created.id, created.prompt, { emit: () => {} });
      const tool = ((lastCreateSessionOptions?.customTools ?? []) as Array<{
        name?: string;
        execute?: (callId: string, params: unknown) => Promise<{
          content: Array<{ text: string }>;
          isError?: boolean;
        }>;
      }>).find((candidate) => candidate.name === 'read_external_memory')!;
      const newSection = [
        '# Task Group: Newly added memory',
        'scope: added after session creation',
        `applies_to: cwd=${projectPath}; reuse_rule=safe`,
      ].join('\n');
      const changedOldSection = oldSection.replace('Original content.', 'Mutated content.');
      writeFileSync(join(memoryDir, 'MEMORY.md'), `${newSection}\n\n${changedOldSection}`);
      const newId = parseCodexMemoryIndex(newSection)[0]!.id;

      expect((await tool.execute?.('new', { source: 'codex', id: newId }))?.isError).toBe(true);
      const existing = await tool.execute?.('old', { source: 'codex', id: oldId });
      expect(existing?.isError).toBeUndefined();
      expect(existing?.content[0]?.text).toContain('Original content.');
      expect(existing?.content[0]?.text).not.toContain('Mutated content.');
    } finally {
      settings.resolve = originalResolve as SettingsService['resolve'];
      rmSync(codexHome, { recursive: true, force: true });
    }
  });

  it('honors the project-facts injection kill-switch', async () => {
    const projectPath = `/tmp/nuncio-context-disabled-${Date.now()}`;
    contextFacts.upsert({
      projectPath,
      key: 'private-rule',
      value: 'This must stay out of the loader.',
      provenance: 'founder',
    });
    const originalResolve = settings.resolve.bind(settings);
    settings.resolve = ((key: string) =>
      key === 'NUNCIO_CONTEXT_FACTS_INJECT' ? 'off' : originalResolve(key)) as SettingsService['resolve'];
    const created = sessions.create({ prompt: 'disabled context probe', provider: 'pi', projectPath });

    try {
      await provider.run(created.id, created.prompt, { emit: () => {} });
      expect(lastLoaderOptions?.appendSystemPrompt).toBeUndefined();
    } finally {
      settings.resolve = originalResolve as SettingsService['resolve'];
    }
  });

  it('restores full extension discovery while still injecting project context', async () => {
    const originalResolve = settings.resolve.bind(settings);
    settings.resolve = ((key: string) =>
      key === 'PI_EXTENSION_DISCOVERY' ? 'full' : originalResolve(key)) as SettingsService['resolve'];
    const projectPath = `/tmp/nuncio-context-full-${Date.now()}`;
    contextFacts.upsert({
      projectPath,
      key: 'runtime',
      value: 'Use Bun in full discovery mode.',
      provenance: 'founder',
    });
    const created = sessions.create({ prompt: 'full discovery probe', provider: 'pi', projectPath });

    try {
      await provider.run(created.id, created.prompt, { emit: () => {} });
      expect(loaderReloadCalls).toBe(1);
      expect(lastCreateSessionOptions?.resourceLoader).toBeDefined();
      expect(lastCreateSessionOptions?.settingsManager).toEqual({ kind: 'settings-manager' });
      expect(lastLoaderOptions?.noExtensions).toBeUndefined();
      expect(lastLoaderOptions?.additionalExtensionPaths).toBeUndefined();
      expect(lastLoaderOptions?.appendSystemPrompt).toEqual([
        expect.stringContaining('Use Bun in full discovery mode.'),
      ]);
    } finally {
      settings.resolve = originalResolve as SettingsService['resolve'];
    }
  });

  it('dispose is a no-op for an unknown session', () => {
    expect(() => provider.dispose('no-such-session')).not.toThrow();
  });

  it('dispose flushes the accepted tail, aborts Pi, and fences queued SDK callbacks', async () => {
    let releasePrompt: () => void = () => undefined;
    const promptStarted = new Promise<void>((resolveStarted) => {
      promptBehavior = async () =>
        new Promise<void>((resolve) => {
          releasePrompt = resolve;
          resolveStarted();
        });
    });
    isStreaming = true;
    const created = sessions.create({ prompt: 'dispose active pi', provider: 'pi' });
    const running = provider.run(created.id, created.prompt, { emit: () => {} });
    await promptStarted;
    const queuedHandler = subscribedHandler!;
    queuedHandler({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: 'accepted tail' },
    });

    provider.dispose(created.id);
    queuedHandler({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: ' stale callback' },
    });
    releasePrompt();
    await running;

    expect(abortMock).toHaveBeenCalledTimes(1);
    expect(subscribedHandler).toBeNull();
    const deltas = events
      .list(created.id)
      .filter((event) => event.type === 'assistant_delta')
      .map((event) => (event.payload as { delta: string }).delta);
    expect(deltas).toEqual(['accepted tail']);
    expect(sessions.findById(created.id)?.status).toBe('RUNNING');
  });

  it('dispose seals an open Pi tool before fencing the run emitter', async () => {
    let releasePrompt: () => void = () => undefined;
    const promptStarted = new Promise<void>((resolveStarted) => {
      promptBehavior = async () =>
        new Promise<void>((resolve) => {
          releasePrompt = resolve;
          resolveStarted();
        });
    });
    isStreaming = true;
    const created = sessions.create({ prompt: 'dispose open tool', provider: 'pi' });
    const running = provider.run(created.id, created.prompt, { emit: () => {} });
    await promptStarted;
    subscribedHandler!({
      type: 'tool_execution_start',
      toolCallId: 'open-call',
      toolName: 'bash',
      args: { command: 'sleep 10' },
    });

    provider.dispose(created.id);
    releasePrompt();
    await running;

    expect(events.list(created.id).filter((event) => (
      (event.type === 'tool_start' || event.type === 'tool_end') &&
      (event.payload as { callId?: string }).callId === 'open-call'
    )).map((event) => event.type)).toEqual(['tool_start', 'tool_end']);
  });

  it('interrupt calls abort on an active session and no-ops without one', async () => {
    await provider.interrupt('no-such-session');
    expect(abortMock).not.toHaveBeenCalled();

    const created = sessions.create({ prompt: 'interrupt me', provider: 'pi' });
    await provider.run(created.id, created.prompt, { emit: () => {} });

    await provider.interrupt(created.id);
    expect(abortMock).toHaveBeenCalledTimes(1);
  });

  it('does not let an idle interrupt swallow the next prompt failure', async () => {
    const created = sessions.create({ prompt: 'prime session', provider: 'pi' });
    await provider.run(created.id, created.prompt, { emit: () => {} });

    await provider.interrupt(created.id);
    promptBehavior = async () => {
      throw new Error('real prompt failure');
    };

    await provider.run(created.id, 'next prompt fails', { emit: () => {} });

    expect(sessions.findById(created.id)?.status).toBe('ERROR');
  });

  it('treats an interrupt during streaming as a clean cancel', async () => {
    let rejectPrompt: (error: Error) => void = () => undefined;
    const promptStarted = new Promise<void>((resolve) => {
      promptBehavior = async () =>
        new Promise<void>((_resolve, reject) => {
          rejectPrompt = reject;
          resolve();
        });
    });
    isStreaming = true;
    const created = sessions.create({ prompt: 'streaming prompt', provider: 'pi' });

    const runPromise = provider.run(created.id, created.prompt, { emit: () => {} });
    await promptStarted;
    await provider.interrupt(created.id);
    rejectPrompt(new Error('aborted by user'));
    await runPromise;

    expect(sessions.findById(created.id)?.status).toBe('IDLE');
  });

  it('seals interrupted Pi activity once and ignores callbacks outside an active turn', async () => {
    let rejectPrompt: (error: Error) => void = () => undefined;
    let turnHandler: NonNullable<typeof subscribedHandler> = () => undefined;
    const promptStarted = new Promise<void>((resolve) => {
      promptBehavior = async () =>
        new Promise<void>((_resolve, reject) => {
          rejectPrompt = reject;
          turnHandler = subscribedHandler ?? turnHandler;
          turnHandler({
            type: 'message_update',
            assistantMessageEvent: { type: 'thinking_start' },
          });
          turnHandler({
            type: 'message_update',
            assistantMessageEvent: { type: 'thinking_delta', delta: 'Inspect the failure.' },
          });
          turnHandler({
            type: 'message_update',
            assistantMessageEvent: { type: 'text_delta', delta: 'partial answer' },
          });
          turnHandler({
            type: 'tool_execution_start',
            toolCallId: 'interrupted-tool',
            toolName: 'bash',
            args: { command: 'bun test' },
          });
          resolve();
        });
    });
    isStreaming = true;
    const created = sessions.create({ prompt: 'interrupt active work', provider: 'pi' });

    const running = provider.run(created.id, created.prompt, { emit: () => {} });
    await promptStarted;
    await provider.interrupt(created.id);
    rejectPrompt(new Error('aborted by user'));
    await running;

    const settledEvents = events.list(created.id);
    expect(settledEvents.filter((event) => event.type === 'thinking_message')).toContainEqual(
      expect.objectContaining({
        payload: expect.objectContaining({ text: 'Inspect the failure.' }),
      }),
    );
    expect(settledEvents.filter((event) => (
      (event.type === 'tool_start' || event.type === 'tool_end') &&
      (event.payload as { callId?: string }).callId === 'interrupted-tool'
    )).map((event) => event.type)).toEqual(['tool_start', 'tool_end']);
    expect(sessions.findById(created.id)?.status).toBe('IDLE');

    const settledCount = settledEvents.length;
    turnHandler({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: ' stale callback' },
    });
    turnHandler({
      type: 'message_end',
      message: {
        role: 'assistant',
        stopReason: 'stop',
        content: [{ type: 'text', text: 'stale callback' }],
      },
    });
    expect(events.list(created.id)).toHaveLength(settledCount);

    isStreaming = false;
    promptBehavior = async () => {
      subscribedHandler?.({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', delta: 'clean next turn' },
      });
      subscribedHandler?.({
        type: 'message_end',
        message: {
          role: 'assistant',
          stopReason: 'stop',
          content: [{ type: 'text', text: 'clean next turn' }],
        },
      });
    };
    await provider.steer(created.id, 'continue cleanly', { emit: () => {} });

    const transcript = JSON.stringify(events.list(created.id).map((event) => event.payload));
    expect(transcript).toContain('clean next turn');
    expect(transcript).not.toContain('stale callback');
  });

  it('setModel resolves the model and applies thinking level on an active session', async () => {
    const created = sessions.create({ prompt: 'switch model', provider: 'pi' });
    await provider.run(created.id, created.prompt, { emit: () => {} });

    await provider.setModel(created.id, 'anthropic:model-1', { thinkingLevel: 'high' });

    expect(setModelMock).toHaveBeenCalledTimes(1);
    expect(setModelMock.mock.calls[0]?.[0]).toMatchObject({ provider: 'anthropic', id: 'model-1' });
    expect(setThinkingLevelMock).toHaveBeenCalledWith('high');
  });

  it('setModel applies Max when the active Pi model advertises it', async () => {
    const created = sessions.create({ prompt: 'switch to max', provider: 'pi' });
    await provider.run(created.id, created.prompt, { emit: () => {} });

    await provider.setModel(created.id, 'anthropic:model-1', { thinkingLevel: 'max' });

    expect(setThinkingLevelMock).toHaveBeenCalledWith('max');
  });

  it('rejects a model switch while the active Pi turn is streaming', async () => {
    const created = sessions.create({ prompt: 'stream before switching', provider: 'pi' });
    await provider.run(created.id, created.prompt, { emit: () => {} });
    isStreaming = true;

    await expect(provider.setModel(created.id, 'anthropic:model-1')).rejects.toThrow(
      'Cannot switch the Pi model while a turn is running.',
    );
    expect(setModelMock).not.toHaveBeenCalled();
  });

  it('refreshes the authoritative runtime manifest after an in-session model switch', async () => {
    const created = sessions.create({
      prompt: 'switch the manifested model',
      provider: 'pi',
      model: 'anthropic:model-0',
    });
    let runtimeEnvironment = buildAgentRuntimeEnvironment({
      sessionId: created.id,
      provider: 'pi',
      model: 'anthropic:model-0',
      projectPath: null,
      cwd: '/tmp/project',
      supportsInteraction: true,
      runtimeTools: { tools: [] },
    });
    let runtimeTools = {
      tools: [createNuncioRuntimeInfoTool(() => runtimeEnvironment)],
    };
    runtimeEnvironment = buildAgentRuntimeEnvironment({
      sessionId: created.id,
      provider: 'pi',
      model: 'anthropic:model-0',
      projectPath: null,
      cwd: '/tmp/project',
      supportsInteraction: true,
      runtimeTools,
    });

    await provider.run(created.id, created.prompt, {
      emit: () => {},
      cwd: '/tmp/project',
      model: 'anthropic:model-0',
      tools: runtimeTools,
      runtimeEnvironment,
    });
    await provider.setModel(created.id, 'anthropic:model-1');

    let switchedEnvironment = buildAgentRuntimeEnvironment({
      sessionId: created.id,
      provider: 'pi',
      model: 'anthropic:model-1',
      projectPath: null,
      cwd: '/tmp/project',
      supportsInteraction: true,
      runtimeTools: { tools: [] },
    });
    runtimeTools = {
      tools: [createNuncioRuntimeInfoTool(() => switchedEnvironment)],
    };
    switchedEnvironment = buildAgentRuntimeEnvironment({
      sessionId: created.id,
      provider: 'pi',
      model: 'anthropic:model-1',
      projectPath: null,
      cwd: '/tmp/project',
      supportsInteraction: true,
      runtimeTools,
    });

    await provider.steer(created.id, 'continue with the switched model', {
      emit: () => {},
      cwd: '/tmp/project',
      model: 'anthropic:model-1',
      tools: runtimeTools,
      runtimeEnvironment: switchedEnvironment,
    });

    expect(createSessionCalls).toBe(2);
    expect((lastLoaderOptions?.appendSystemPrompt as string[])[0]).toContain(
      'provider/model: pi / anthropic:model-1',
    );
    const customTools = lastCreateSessionOptions?.customTools as Array<{
      name?: string;
      execute?: (callId: string, input: unknown) => Promise<{ details?: unknown }>;
    }>;
    const infoTool = customTools.find((tool) => tool.name === 'nuncio_runtime_info');
    expect((await infoTool?.execute?.('runtime-info', {}))?.details).toMatchObject({
      session: { model: 'anthropic:model-1' },
    });
  });

  it('setModel no-ops without an active session', async () => {
    await provider.setModel('no-such-session', 'anthropic:model-1', { thinkingLevel: 'high' });
    expect(setModelMock).not.toHaveBeenCalled();
    expect(setThinkingLevelMock).not.toHaveBeenCalled();
  });

  it('keeps the Pi user prompt exact while placing the Nuncio envelope in the system prompt', async () => {
    const created = sessions.create({ prompt: 'inspect the page', provider: 'pi' });
    const tools = {
      systemPromptAppend: 'Use browser_open for browser work.',
      tools: [{ name: 'browser_open', inputSchema: {}, execute: async () => 'opened' }],
    };
    const runtimeEnvironment = buildAgentRuntimeEnvironment({
      sessionId: created.id,
      provider: 'pi',
      model: null,
      projectPath: null,
      cwd: '/tmp/project',
      supportsInteraction: true,
      runtimeTools: tools,
    });

    await provider.run(created.id, created.prompt, {
      emit: () => {},
      cwd: '/tmp/project',
      tools,
      runtimeEnvironment,
    });

    expect(promptCalls[0]?.text).toBe('inspect the page');
    expect(lastLoaderOptions?.appendSystemPrompt).toEqual([
      expect.stringContaining('running inside Nuncio'),
    ]);
    expect((lastLoaderOptions?.appendSystemPrompt as string[])[0]).toContain(
      'Use browser_open for browser work.',
    );
  });

  it('passes image attachments to Pi prompt options', async () => {
    const created = sessions.create({ prompt: 'describe image', provider: 'pi' });

    await provider.run(created.id, created.prompt, {
      emit: () => {},
      attachments: [
        { kind: 'image', mimeType: 'image/png', data: 'base64-data' },
      ],
    });

    expect(promptCalls[0]).toEqual({
      text: created.prompt,
      options: { images: [{ type: 'image', mimeType: 'image/png', data: 'base64-data' }] },
    });
  });

  it('steerMidRun queues into a live streaming run and records the steer message', async () => {
    const created = sessions.create({ prompt: 'long task', provider: 'pi' });
    await provider.run(created.id, created.prompt, { emit: () => {} });

    isStreaming = true;
    const emitted: Array<{ type: string }> = [];
    const handled = await provider.steerMidRun(created.id, 'change course', {
      emit: (event) => emitted.push(event),
    });

    expect(handled).toBe(true);
    expect(steerMock).toHaveBeenCalledTimes(1);
    expect(steerMock.mock.calls[0]?.[0]).toBe('change course');
    expect(emitted.some((e) => e.type === 'steer_message')).toBe(true);
  });

  it('steers a Solo run when stable tool definitions are rebuilt with fresh closures', async () => {
    const runtimeTools = () => ({
      systemPromptAppend: 'Use the session browser tool when needed.',
      tools: [{
        name: 'browser_state',
        description: 'Read the current browser state.',
        inputSchema: { type: 'object', properties: {} },
        execute: async () => 'state',
      }],
    });
    const created = sessions.create({ prompt: 'browse during a long task', provider: 'pi' });
    await provider.run(created.id, created.prompt, { emit: () => {}, tools: runtimeTools() });

    isStreaming = true;
    const handled = await provider.steerMidRun(created.id, 'check the next page', {
      emit: () => {},
      tools: runtimeTools(),
    });

    expect(handled).toBe(true);
    expect(steerMock).toHaveBeenCalledWith('check the next page', undefined);
  });

  it('does not invoke the live SDK steer until its durable reservation recovers', async () => {
    const created = sessions.create({ prompt: 'durable live steer', provider: 'pi' });
    await provider.run(created.id, created.prompt, { emit: () => {} });
    isStreaming = true;
    const originalAppend = events.append.bind(events);
    let blockReservation = true;
    events.append = ((sessionId: string, type: string, payload: unknown, notify?: boolean) => {
      if (type === 'steer_reserved' && blockReservation) throw new Error('storage unavailable');
      return originalAppend(sessionId, type, payload, notify);
    }) as EventsRepository['append'];

    const steering = provider.steerMidRun(created.id, 'persist me first', {});
    try {
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(steerMock).not.toHaveBeenCalled();
      blockReservation = false;
      await steering;
      expect(steerMock).toHaveBeenCalledWith('persist me first', undefined);
      expect(events.list(created.id)).toContainEqual(
        expect.objectContaining({ type: 'steer_message', payload: { text: 'persist me first' } }),
      );
    } finally {
      blockReservation = false;
      events.append = originalAppend as EventsRepository['append'];
      await steering.catch(() => undefined);
    }
  });

  it('returns a persisted steer to the normal queue when the Pi turn ends during recovery', async () => {
    const created = sessions.create({ prompt: 'live recovery race', provider: 'pi' });
    let finishTurn: () => void = () => undefined;
    promptBehavior = async () => new Promise<void>((resolve) => { finishTurn = resolve; });
    isStreaming = true;
    const run = provider.run(created.id, created.prompt, { emit: () => {} });
    await new Promise((resolve) => setTimeout(resolve, 20));

    const originalAppend = events.append.bind(events);
    let blockReservation = true;
    events.append = ((sessionId: string, type: string, payload: unknown, notify?: boolean) => {
      if (type === 'steer_reserved' && blockReservation) throw new Error('storage unavailable');
      return originalAppend(sessionId, type, payload, notify);
    }) as EventsRepository['append'];

    const steering = provider.steerMidRun(created.id, 'queue me after recovery', {});
    try {
      await new Promise((resolve) => setTimeout(resolve, 20));
      isStreaming = false;
      finishTurn();
      const retained = (provider as unknown as {
        retainedEvents: Map<string, Array<{ type: string; payload: unknown }>>;
      }).retainedEvents;
      const started = Date.now();
      while (
        !retained.get(created.id)?.some((event) =>
          event.type === 'status' && (event.payload as { status?: string }).status === 'IDLE') &&
        Date.now() - started < 1_000
      ) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      blockReservation = false;

      expect(await steering).toBe(false);
      await run;
      expect(steerMock).not.toHaveBeenCalled();
      expect(events.list(created.id).some((event) => event.type === 'steer_message')).toBe(false);
      expect(events.list(created.id).some((event) => event.type === 'steer_reserved')).toBe(true);
      expect(sessions.findById(created.id)?.status).toBe('IDLE');
    } finally {
      blockReservation = false;
      events.append = originalAppend as EventsRepository['append'];
      finishTurn();
      await Promise.allSettled([steering, run]);
    }
  });

  it('steerMidRun stamps context.steerOrigin onto the emitted steer_message', async () => {
    const created = sessions.create({ prompt: 'long task', provider: 'pi' });
    await provider.run(created.id, created.prompt, { emit: () => {} });

    isStreaming = true;
    const emitted: Array<{ type: string; payload: unknown }> = [];
    await provider.steerMidRun(created.id, 'digest wake', {
      emit: (event) => emitted.push(event),
      steerOrigin: 'task-digest',
    });

    const steer = emitted.find((e) => e.type === 'steer_message');
    expect((steer?.payload as { origin?: string }).origin).toBe('task-digest');
  });

  it('steerMidRun reports false when the session is not streaming', async () => {
    const created = sessions.create({ prompt: 'idle task', provider: 'pi' });
    await provider.run(created.id, created.prompt, { emit: () => {} });

    isStreaming = false;
    const handled = await provider.steerMidRun(created.id, 'nothing to steer', { emit: () => {} });

    expect(handled).toBe(false);
    expect(steerMock).not.toHaveBeenCalled();
  });

  it('emits one assistant_message per completed turn, matching the session file', async () => {
    const emitted: Array<{ type: string; payload: Record<string, unknown> }> = [];
    promptBehavior = async () => {
      subscribedHandler?.({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', delta: 'first turn' },
      });
      subscribedHandler?.({
        type: 'message_end',
        message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'first turn' }] },
      });
      subscribedHandler?.({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', delta: 'second turn' },
      });
      subscribedHandler?.({
        type: 'message_end',
        message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'second turn' }] },
      });
    };
    const created = sessions.create({ prompt: 'two turns', provider: 'pi' });

    await provider.run(created.id, created.prompt, {
      emit: (event) => emitted.push(event as { type: string; payload: Record<string, unknown> }),
    });

    const messages = emitted
      .filter((e) => e.type === 'assistant_message')
      .map((e) => e.payload.text);
    expect(messages).toEqual(['first turn', 'second turn']);
  });

  it('does not fabricate an assistant message for a successful tool-only turn', async () => {
    promptBehavior = async () => {
      subscribedHandler?.({
        type: 'tool_execution_start',
        toolCallId: 'tool-only-call',
        toolName: 'bash',
        args: { command: 'bun test' },
      });
      subscribedHandler?.({
        type: 'tool_execution_end',
        toolCallId: 'tool-only-call',
        toolName: 'bash',
        result: 'ok',
        isError: false,
      });
      subscribedHandler?.({
        type: 'message_end',
        message: { role: 'assistant', stopReason: 'stop', content: [] },
      });
    };
    const created = sessions.create({ prompt: 'perform the tool only', provider: 'pi' });

    await provider.run(created.id, created.prompt, { emit: () => {} });

    const all = events.list(created.id);
    expect(all.filter((event) => event.type === 'tool_start')).toHaveLength(1);
    expect(all.filter((event) => event.type === 'tool_end')).toHaveLength(1);
    expect(all.filter((event) => event.type === 'assistant_message')).toHaveLength(0);
    expect(sessions.findById(created.id)?.status).toBe('IDLE');
  });

  it('persists and emits the first Pi delta before a burst completes', async () => {
    let releasePrompt: () => void = () => undefined;
    const promptStarted = new Promise<void>((resolveStarted) => {
      promptBehavior = async () =>
        new Promise<void>((resolve) => {
          releasePrompt = resolve;
          resolveStarted();
        });
    });
    const emitted: Array<{ seq?: number; type: string; payload: Record<string, unknown> }> = [];
    const created = sessions.create({ prompt: 'stream a burst', provider: 'pi' });
    const running = provider.run(created.id, created.prompt, {
      emit: (event) => emitted.push(event as never),
    });
    await promptStarted;

    subscribedHandler?.({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: '0' },
    });
    const firstPersisted = events.list(created.id).find((event) => event.type === 'assistant_delta');
    const firstEmitted = emitted.find((event) => event.type === 'assistant_delta');
    expect(firstPersisted?.seq).toBeGreaterThan(0);
    expect(firstEmitted?.seq).toBe(firstPersisted?.seq);

    for (let index = 1; index < 100; index += 1) {
      subscribedHandler?.({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', delta: `|${index}` },
      });
    }
    releasePrompt();
    await running;

    const reconstructed = events.list(created.id)
      .filter((event) => event.type === 'assistant_delta')
      .map((event) => (event.payload as { delta: string }).delta)
      .join('');
    expect(reconstructed).toBe(Array.from({ length: 100 }, (_, index) => (
      index === 0 ? '0' : `|${index}`
    )).join(''));
  });

  it('surfaces a turn error as an error event and ERROR status instead of "(no response)"', async () => {
    const emitted: Array<{ type: string; payload: Record<string, unknown> }> = [];
    promptBehavior = async () => {
      subscribedHandler?.({
        type: 'message_end',
        message: {
          role: 'assistant',
          stopReason: 'error',
          errorMessage: "400 You're out of extra usage.",
          content: [],
        },
      });
    };
    const created = sessions.create({ prompt: 'quota exceeded', provider: 'pi' });

    await provider.run(created.id, created.prompt, {
      emit: (event) => emitted.push(event as { type: string; payload: Record<string, unknown> }),
    });

    expect(sessions.findById(created.id)?.status).toBe('ERROR');
    const error = emitted.find((e) => e.type === 'error');
    expect(String(error?.payload.message)).toContain('out of extra usage');
    expect(
      emitted.some((e) => e.type === 'assistant_message' && e.payload.text === '(no response)'),
    ).toBe(false);
  });

  it('settles successfully when Pi auto-retries after an assistant error', async () => {
    const emitted: Array<{ type: string; payload: Record<string, unknown> }> = [];
    promptBehavior = async () => {
      subscribedHandler?.({
        type: 'message_end',
        message: {
          role: 'assistant',
          stopReason: 'error',
          errorMessage: 'temporary upstream failure',
          content: [],
        },
      });
      subscribedHandler?.({
        type: 'message_end',
        message: {
          role: 'assistant',
          stopReason: 'stop',
          content: [{ type: 'text', text: 'Recovered after retry' }],
        },
      });
    };
    const created = sessions.create({ prompt: 'retry this turn', provider: 'pi' });

    await provider.run(created.id, created.prompt, {
      emit: (event) => emitted.push(event as { type: string; payload: Record<string, unknown> }),
    });

    expect(sessions.findById(created.id)?.status).toBe('IDLE');
    expect(emitted).toContainEqual(
      expect.objectContaining({
        type: 'assistant_message',
        payload: { text: 'Recovered after retry' },
      }),
    );
    expect(emitted.some((event) => event.type === 'error')).toBe(false);
  });

  it('omits image options when there are no attachments', async () => {
    const created = sessions.create({ prompt: 'no image', provider: 'pi' });

    await provider.run(created.id, created.prompt, { emit: () => {} });

    expect(promptCalls[0]).toEqual({ text: created.prompt, options: undefined });
  });

  it('emits Pi tool events with callId, summarized input, output, and error state', async () => {
    const emitted: Array<{ type: string; payload: Record<string, unknown> }> = [];
    promptBehavior = async () => {
      subscribedHandler?.({
        type: 'tool_execution_start',
        toolCallId: 'call-1',
        toolName: 'bash',
        args: { command: 'bun test apps/server/test/unit/agents/pi-agent.provider.spec.ts' },
      });
      subscribedHandler?.({
        type: 'tool_execution_end',
        toolCallId: 'call-1',
        toolName: 'bash',
        result: 'ok',
        isError: false,
      });
    };
    const created = sessions.create({ prompt: 'run a command', provider: 'pi' });

    await provider.run(created.id, created.prompt, {
      emit: (event) => emitted.push(event as { type: string; payload: Record<string, unknown> }),
    });

    expect(emitted).toContainEqual(
      expect.objectContaining({
        type: 'tool_start',
        payload: {
          callId: 'call-1',
          tool: 'bash',
          input: { command: 'bun test apps/server/test/unit/agents/pi-agent.provider.spec.ts' },
        },
      }),
    );
    expect(emitted).toContainEqual(
      expect.objectContaining({
        type: 'tool_end',
        payload: { callId: 'call-1', tool: 'bash', isError: false, output: 'ok' },
      }),
    );
  });

  it('maps todo_write calls to plan_updated instead of tool blocks', async () => {
    const emitted: Array<{ type: string; payload: Record<string, unknown> }> = [];
    promptBehavior = async () => {
      subscribedHandler?.({
        type: 'tool_execution_start',
        toolCallId: 'todo-1',
        toolName: 'todo_write',
        args: {
          items: [
            { id: 'a', text: 'Read the code', status: 'done' },
            { text: 'Write the fix', status: 'in_progress' },
          ],
        },
      });
      subscribedHandler?.({
        type: 'tool_execution_end',
        toolCallId: 'todo-1',
        toolName: 'todo_write',
        result: 'Todo list updated: 1/2 done.',
        isError: false,
      });
    };
    const created = sessions.create({ prompt: 'plan the work', provider: 'pi' });

    await provider.run(created.id, created.prompt, {
      emit: (event) => emitted.push(event as { type: string; payload: Record<string, unknown> }),
    });

    expect(emitted).toContainEqual(
      expect.objectContaining({
        type: 'plan_updated',
        payload: {
          items: [
            { id: 'a', text: 'Read the code', status: 'done' },
            { id: 'item-2', text: 'Write the fix', status: 'in_progress' },
          ],
        },
      }),
    );
    expect(emitted.some((e) => e.type === 'tool_start' && e.payload.tool === 'todo_write')).toBe(
      false,
    );
    expect(emitted.some((e) => e.type === 'tool_end' && e.payload.tool === 'todo_write')).toBe(
      false,
    );
  });

  it('routes plan updates through the current turn emitter on a reused Pi session', async () => {
    const firstTurn: string[] = [];
    const secondTurn: string[] = [];
    const created = sessions.create({ prompt: 'reuse the session', provider: 'pi' });
    await provider.run(created.id, created.prompt, {
      emit: (event) => firstTurn.push(event.type),
    });
    promptBehavior = async () => {
      subscribedHandler?.({
        type: 'tool_execution_start',
        toolCallId: 'todo-reused-session',
        toolName: 'todo_write',
        args: { items: [{ text: 'Use the latest emitter', status: 'in_progress' }] },
      });
      subscribedHandler?.({
        type: 'tool_execution_end',
        toolCallId: 'todo-reused-session',
        toolName: 'todo_write',
        result: 'ok',
        isError: false,
      });
    };

    await provider.steer(created.id, 'update the plan', {
      emit: (event) => secondTurn.push(event.type),
    });

    expect(firstTurn.filter((type) => type === 'plan_updated')).toEqual([]);
    expect(secondTurn.filter((type) => type === 'plan_updated')).toEqual(['plan_updated']);
  });

  it('clears suppressed plan call ids when a turn ends without tool_execution_end', async () => {
    const created = sessions.create({ prompt: 'start an unfinished plan tool', provider: 'pi' });
    promptBehavior = async () => {
      subscribedHandler?.({
        type: 'tool_execution_start',
        toolCallId: 'reused-call-id',
        toolName: 'todo_write',
        args: { items: [{ text: 'First turn', status: 'in_progress' }] },
      });
    };
    await provider.run(created.id, created.prompt, { emit: () => {} });

    promptBehavior = async () => {
      subscribedHandler?.({
        type: 'tool_execution_start',
        toolCallId: 'reused-call-id',
        toolName: 'bash',
        args: { command: 'bun test' },
      });
      subscribedHandler?.({
        type: 'tool_execution_end',
        toolCallId: 'reused-call-id',
        toolName: 'bash',
        result: 'ok',
        isError: false,
      });
    };
    const emitted: Array<{ type: string; payload: Record<string, unknown> }> = [];
    await provider.steer(created.id, 'reuse the call id', {
      emit: (event) => emitted.push(event as { type: string; payload: Record<string, unknown> }),
    });

    expect(emitted).toContainEqual(
      expect.objectContaining({
        type: 'tool_end',
        payload: expect.objectContaining({
          callId: 'reused-call-id',
          tool: 'bash',
          output: 'ok',
        }),
      }),
    );
  });

  it('registers the todo_write custom tool on the pi session', async () => {
    const created = sessions.create({ prompt: 'tool check', provider: 'pi' });
    await provider.run(created.id, created.prompt, { emit: () => {} });

    const tools = (lastCreateSessionOptions?.customTools ?? []) as Array<{ name?: string }>;
    expect(tools.some((tool) => tool.name === 'todo_write')).toBe(true);
    expect(tools.some((tool) => tool.name === 'AskUserQuestion')).toBe(true);
    expect(tools.some((tool) => tool.name === 'read_external_memory')).toBe(true);
  });

  it('emits Pi thinking events from message_update reasoning without adding it to assistant text', async () => {
    const emitted: Array<{ type: string; payload: Record<string, unknown> }> = [];
    promptBehavior = async () => {
      subscribedHandler?.({
        type: 'message_update',
        assistantMessageEvent: { type: 'thinking_start' },
      });
      subscribedHandler?.({
        type: 'message_update',
        assistantMessageEvent: { type: 'thinking_delta', delta: 'plan' },
      });
      subscribedHandler?.({
        type: 'message_update',
        assistantMessageEvent: { type: 'thinking_end', content: 'plan' },
      });
      subscribedHandler?.({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', delta: 'Answer' },
      });
    };
    const created = sessions.create({ prompt: 'think', provider: 'pi' });

    await provider.run(created.id, created.prompt, {
      emit: (event) => emitted.push(event as { type: string; payload: Record<string, unknown> }),
    });

    const thinkingStart = emitted.find((event) => event.type === 'thinking_start');
    expect(thinkingStart?.payload.thinkingId).toEqual(expect.any(String));
    expect(emitted).toContainEqual(
      expect.objectContaining({
        type: 'thinking_delta',
        payload: { thinkingId: thinkingStart?.payload.thinkingId, delta: 'plan' },
      }),
    );
    expect(emitted).toContainEqual(
      expect.objectContaining({
        type: 'thinking_message',
        payload: { thinkingId: thinkingStart?.payload.thinkingId, text: 'plan' },
      }),
    );
    expect(emitted.findLast((event) => event.type === 'assistant_message')?.payload).toEqual({
      text: 'Answer',
    });
  });

  it('seals any still-running Pi tool when the prompt completes', async () => {
    const emitted: Array<{ type: string; payload: Record<string, unknown> }> = [];
    promptBehavior = async () => {
      subscribedHandler?.({
        type: 'tool_execution_start',
        toolCallId: 'open-call',
        toolName: 'grep',
        args: { pattern: 'TODO', path: 'src' },
      });
      subscribedHandler?.({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', delta: 'Done' },
      });
    };
    const created = sessions.create({ prompt: 'leave tool open', provider: 'pi' });

    await provider.run(created.id, created.prompt, {
      emit: (event) => emitted.push(event as { type: string; payload: Record<string, unknown> }),
    });

    const toolEndIndex = emitted.findIndex(
      (event) => event.type === 'tool_end' && event.payload.callId === 'open-call',
    );
    const assistantMessageIndex = emitted.findIndex((event) => event.type === 'assistant_message');
    expect(emitted[toolEndIndex]).toEqual(
      expect.objectContaining({
        type: 'tool_end',
        payload: { callId: 'open-call', tool: 'grep', isError: false },
      }),
    );
    expect(toolEndIndex).toBeGreaterThan(-1);
    expect(assistantMessageIndex).toBeGreaterThan(toolEndIndex);
  });

  it('persists the Pi session file after creating an agent session', async () => {
    fakeSessionFile = '/tmp/fake-pi/persisted-session.jsonl';
    const created = sessions.create({ prompt: 'persist session file', provider: 'pi' });
    const originalUpdate = sessions.updateProviderRuntimeState.bind(sessions);
    const updateSpy = mock((...args: Parameters<SessionsRepository['updateProviderRuntimeState']>) =>
      originalUpdate(...args),
    );
    sessions.updateProviderRuntimeState = updateSpy as SessionsRepository['updateProviderRuntimeState'];

    try {
      await provider.run(created.id, created.prompt, { emit: () => {} });

      expect(updateSpy).toHaveBeenCalledWith(created.id, { providerThreadId: fakeSessionFile });
      expect(sessions.findById(created.id)?.providerThreadId).toBe(fakeSessionFile);
    } finally {
      sessions.updateProviderRuntimeState = originalUpdate;
    }
  });

  it('invalidates a Pi thread that cannot be opened instead of silently starting fresh', async () => {
    const created = sessions.create({
      prompt: 'resume stale Pi thread', provider: 'pi', providerThreadId: '/tmp/stale-pi-session.jsonl',
    });
    sessionOpenError = new Error('session file is gone');

    await provider.run(created.id, created.prompt, { emit: () => {} });

    const failed = sessions.findById(created.id)!;
    expect(failed.status).toBe('ERROR');
    expect(failed.providerThreadId).toBeNull();
    expect(provider.canResumeThread(failed)).toBe(false);
    expect(createSessionCalls).toBe(0);
  });
});
