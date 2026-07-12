import { beforeAll, afterAll, beforeEach, describe, it, expect, mock } from 'bun:test';
import { Test, TestingModule } from '@nestjs/testing';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PiAgentProvider } from '../../../src/agents/providers/pi-agent.provider';
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

let availableModelCount = 0;
let fakeSessionFile = '/tmp/fake-pi/session.jsonl';
let promptCalls: Array<{ text: string; options: unknown }> = [];
let promptBehavior: ((text: string, options?: unknown) => Promise<void>) | null = null;
let isStreaming = false;
let subscribedHandler: ((event: { type: string; [key: string]: unknown }) => void) | null = null;
let sessionOpenError: Error | null = null;
let createSessionCalls = 0;
const abortMock = mock(async () => undefined);
const steerMock = mock(async (_text: string, _images?: unknown) => undefined);
const setModelMock = mock(async (_model: unknown) => undefined);
const setThinkingLevelMock = mock((_level: unknown) => undefined);

function registryModel(provider = 'anthropic', id = 'model-1') {
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

mock.module('@earendil-works/pi-coding-agent', () => ({
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
    create: () => ({
      getAvailable: () => Array.from({ length: availableModelCount }, (_, i) => ({
        provider: 'anthropic',
        id: `model-${i}`,
        name: `Model ${i}`,
      })),
      getProviderDisplayName: (provider: string) => provider,
      find: (provider: string, id: string) => (provider === 'anthropic' ? registryModel(provider, id) : undefined),
    }),
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
}));

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

  it('appends deterministic project facts and the latest project handoff brief', async () => {
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
    tasks.create({
      prompt: 'latest task',
      projectPath,
      contextBrief: { goal: 'Honor the latest brief.' },
    });
    const created = sessions.create({ prompt: 'context probe', provider: 'pi', projectPath });

    await provider.run(created.id, created.prompt, { emit: () => {} });

    const appended = lastLoaderOptions?.appendSystemPrompt as string[];
    expect(appended).toHaveLength(1);
    expect(appended[0]!.startsWith('## Nuncio project context')).toBe(true);
    expect(appended[0]!.indexOf('**runtime**')).toBeLessThan(
      appended[0]!.indexOf('## Handoff brief'),
    );
    expect(appended[0]).toContain('Honor the latest brief.');
    expect(appended[0]).not.toContain('Ignore the older brief.');
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

  it('restores Pi default extension discovery only for the explicit full escape hatch', async () => {
    const originalResolve = settings.resolve.bind(settings);
    settings.resolve = ((key: string) =>
      key === 'PI_EXTENSION_DISCOVERY' ? 'full' : originalResolve(key)) as SettingsService['resolve'];
    const created = sessions.create({ prompt: 'full discovery probe', provider: 'pi' });

    try {
      await provider.run(created.id, created.prompt, { emit: () => {} });
      expect(loaderReloadCalls).toBe(0);
      expect(lastCreateSessionOptions?.resourceLoader).toBeUndefined();
      expect(lastCreateSessionOptions?.settingsManager).toBeUndefined();
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

  it('setModel no-ops without an active session', async () => {
    await provider.setModel('no-such-session', 'anthropic:model-1', { thinkingLevel: 'high' });
    expect(setModelMock).not.toHaveBeenCalled();
    expect(setThinkingLevelMock).not.toHaveBeenCalled();
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
