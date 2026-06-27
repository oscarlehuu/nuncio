import { Test, TestingModule } from '@nestjs/testing';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EventEmitter } from '../../../src/agents/agents.types';
import { parseCursorModel } from '../../../src/agents/providers/cursor-agent.helpers';
import { CursorAgentProvider } from '../../../src/agents/providers/cursor-agent.provider';
import { DatabaseModule } from '../../../src/db/database.module';
import { EventsRepository } from '../../../src/sessions/persistence/events.repository';
import { SessionsPersistenceModule } from '../../../src/sessions/sessions.persistence.module';
import { SessionsRepository } from '../../../src/sessions/persistence/sessions.repository';
import { SettingsModule } from '../../../src/settings/settings.module';

type StubOpts = {
  models?: string[];
  modelsListThrows?: boolean;
  createThrows?: Error;
  waitStatus?: 'finished' | 'error' | 'cancelled';
  waitResult?: string;
  streamEvents?: Array<{ type: string; [key: string]: unknown }>;
  deltaUpdates?: Array<{ type: string; text?: string; toolCall?: { type?: string; status?: string; isError?: boolean }; [key: string]: unknown }>;
};

function makeStubSdk(opts: StubOpts = {}) {
  const createCalls: unknown[] = [];
  const sendCalls: string[] = [];
  const sendOptionsCalls: unknown[] = [];
  const closeCalls: number[] = [];
  const modelsListCalls: number[] = [];

  const agent = {
    agentId: 'stub-agent-1',
    send: async (text: string, options?: { onDelta?: (args: { update: { type: string; [key: string]: unknown } }) => void }) => {
      sendCalls.push(text);
      sendOptionsCalls.push(options);
      // Fire onDelta updates (simulating the SDK streaming tokens/tool state).
      for (const update of opts.deltaUpdates ?? []) {
        options?.onDelta?.({ update });
      }
      return {
        id: 'stub-run-1',
        stream: async function* () {
          for (const e of opts.streamEvents ?? []) yield e;
        },
        wait: async () => ({
          id: 'stub-run-1',
          status: opts.waitStatus ?? 'finished',
          result: opts.waitResult,
          durationMs: 5,
        }),
        supports: () => true,
      };
    },
    close: () => {
      closeCalls.push(1);
    },
    [Symbol.asyncDispose]: async () => {
      closeCalls.push(1);
    },
  };

  const sdk = {
    Agent: {
      create: async (args: unknown) => {
        createCalls.push(args);
        if (opts.createThrows) throw opts.createThrows;
        return agent;
      },
      prompt: async () => ({ status: 'finished' }),
      resume: async () => agent,
      get: async () => agent,
      list: async () => ({ items: [], nextCursor: undefined }),
    },
    Cursor: {
      models: {
        list: async () => {
          modelsListCalls.push(1);
          if (opts.modelsListThrows) throw new Error('net');
          return (opts.models ?? ['composer-2']).map((id) => ({ id }));
        },
      },
    },
    CursorAgentError: class CursorAgentError extends Error {},
    JsonlLocalAgentStore: class JsonlLocalAgentStore {
      constructor(public dir: string) {}
    },
  };

  return { sdk, createCalls, sendCalls, sendOptionsCalls, closeCalls, modelsListCalls };
}

describe('parseCursorModel', () => {
  it('strips cursor: prefix', () => {
    expect(parseCursorModel('cursor:composer-2')).toBe('composer-2');
  });

  it('returns bare ids unchanged', () => {
    expect(parseCursorModel('gpt-5')).toBe('gpt-5');
  });

  it('returns undefined for empty input', () => {
    expect(parseCursorModel('')).toBeUndefined();
    expect(parseCursorModel(null)).toBeUndefined();
  });
});

describe('CursorAgentProvider', () => {
  let module: TestingModule;
  let provider: CursorAgentProvider;
  let sessions: SessionsRepository;
  let events: EventsRepository;
  let dataDir: string;
  let previousKey: string | undefined;
  let previousForceMock: string | undefined;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-cursor-provider-'));
    process.env.NUNCIO_DATA_DIR = dataDir;
    previousKey = process.env.CURSOR_API_KEY;
    previousForceMock = process.env.NUNCIO_FORCE_MOCK;
    delete process.env.NUNCIO_FORCE_MOCK;

    module = await Test.createTestingModule({
      imports: [DatabaseModule, SessionsPersistenceModule, SettingsModule],
      providers: [CursorAgentProvider],
    }).compile();

    provider = module.get(CursorAgentProvider);
    sessions = module.get(SessionsRepository);
    events = module.get(EventsRepository);
  });

  afterAll(async () => {
    await module.close();
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.NUNCIO_DATA_DIR;
    if (previousKey === undefined) delete process.env.CURSOR_API_KEY;
    else process.env.CURSOR_API_KEY = previousKey;
    if (previousForceMock === undefined) delete process.env.NUNCIO_FORCE_MOCK;
    else process.env.NUNCIO_FORCE_MOCK = previousForceMock;
  });

  beforeEach(() => {
    provider.sdkOverride = undefined;
    (provider as unknown as { cachedAvailable?: boolean }).cachedAvailable = undefined;
    (provider as unknown as { cachedModels?: unknown }).cachedModels = undefined;
    (provider as unknown as { store?: unknown }).store = undefined;
  });

  it('isAvailable returns false when CURSOR_API_KEY is missing', async () => {
    delete process.env.CURSOR_API_KEY;
    expect(await provider.isAvailable()).toBe(false);
  });

  it('isAvailable returns false when NUNCIO_FORCE_MOCK=1 even with key', async () => {
    process.env.CURSOR_API_KEY = 'cursor_test_key';
    process.env.NUNCIO_FORCE_MOCK = '1';
    expect(await provider.isAvailable()).toBe(false);
    delete process.env.NUNCIO_FORCE_MOCK;
  });

  it('isAvailable returns true when CURSOR_API_KEY is set', async () => {
    process.env.CURSOR_API_KEY = 'cursor_test_key';
    expect(await provider.isAvailable()).toBe(true);
  });

  it('isAvailable caches the result', async () => {
    process.env.CURSOR_API_KEY = 'cursor_test_key';
    expect(await provider.isAvailable()).toBe(true);
    delete process.env.CURSOR_API_KEY;
    expect(await provider.isAvailable()).toBe(true);
  });

  it('isAvailable does not poison the cache when NUNCIO_FORCE_MOCK is unset later', async () => {
    process.env.CURSOR_API_KEY = 'cursor_test_key';
    process.env.NUNCIO_FORCE_MOCK = '1';
    expect(await provider.isAvailable()).toBe(false);
    delete process.env.NUNCIO_FORCE_MOCK;
    expect(await provider.isAvailable()).toBe(true);
  });

  it('isAvailable never calls Agent.create', async () => {
    const { sdk, createCalls } = makeStubSdk();
    provider.sdkOverride = sdk as never;
    process.env.CURSOR_API_KEY = 'cursor_test_key';
    await provider.isAvailable();
    expect(createCalls).toHaveLength(0);
  });

  it('listModels maps Cursor.models.list to ModelProviderDto', async () => {
    const { sdk } = makeStubSdk({ models: ['composer-2', 'gpt-5'] });
    provider.sdkOverride = sdk as never;
    process.env.CURSOR_API_KEY = 'cursor_test_key';

    const models = await provider.listModels();
    expect(models).toHaveLength(1);
    expect(models[0].id).toBe('cursor');
    expect(models[0].groups?.[0].models.map((m) => m.id)).toEqual([
      'cursor:composer-2',
      'cursor:gpt-5',
    ]);
  });

  it('listModels omits the cursor "default" model entry', async () => {
    const { sdk } = makeStubSdk({ models: ['default', 'composer-2.5', 'gpt-5'] });
    provider.sdkOverride = sdk as never;
    process.env.CURSOR_API_KEY = 'cursor_test_key';

    const models = await provider.listModels();
    expect(models[0].groups?.[0].models.map((m) => m.id)).toEqual([
      'cursor:composer-2.5',
      'cursor:gpt-5',
    ]);
  });

  it('listModels caches Cursor.models.list result', async () => {
    const { sdk, modelsListCalls } = makeStubSdk();
    provider.sdkOverride = sdk as never;
    process.env.CURSOR_API_KEY = 'cursor_test_key';

    await provider.listModels();
    await provider.listModels();
    expect(modelsListCalls).toHaveLength(1);
  });

  it('listModels falls back to static catalog when SDK throws', async () => {
    const { sdk } = makeStubSdk({ modelsListThrows: true });
    provider.sdkOverride = sdk as never;
    process.env.CURSOR_API_KEY = 'cursor_test_key';

    const models = await provider.listModels();
    expect(models[0].groups?.[0].models[0].id).toBe('cursor:composer-2.5');
  });

  it('dispose is a no-op for unknown session', () => {
    expect(() => provider.dispose('missing')).not.toThrow();
  });

  it('dispose calls agent.close and removes handle', async () => {
    const { sdk, closeCalls, createCalls } = makeStubSdk({
      streamEvents: [
        {
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text: 'Hi' }] },
        },
      ],
      waitResult: 'Hi',
    });
    provider.sdkOverride = sdk as never;
    process.env.CURSOR_API_KEY = 'cursor_test_key';

    const created = sessions.create({ prompt: 'hello', provider: 'cursor' });
    await provider.run(created.id, created.prompt, { emit: () => {} });
    expect(createCalls).toHaveLength(1);

    provider.dispose(created.id);
    expect(closeCalls).toHaveLength(1);
    provider.dispose(created.id);
    expect(closeCalls).toHaveLength(1);
  });

  it('run maps assistant and tool_call events and reaches IDLE (case A)', async () => {
    const { sdk } = makeStubSdk({
      deltaUpdates: [
        { type: 'text-delta', text: 'Hello' },
        { type: 'tool-call-started', toolCall: { type: 'grep' } },
        { type: 'tool-call-completed', toolCall: { type: 'grep' } },
      ],
      waitResult: 'Hello world',
    });
    provider.sdkOverride = sdk as never;
    process.env.CURSOR_API_KEY = 'cursor_test_key';

    const created = sessions.create({ prompt: 'do task', provider: 'cursor' });
    const emitted: { type: string; payload: unknown }[] = [];
    const emit: EventEmitter = (event) => emitted.push(event);

    await provider.run(created.id, created.prompt, { emit });

    const all = events.list(created.id);
    const types = all.map((e) => e.type);
    expect(types).toContain('user_message');
    expect(types).toContain('assistant_delta');
    expect(types).toContain('tool_start');
    expect(types).toContain('tool_end');
    expect(types).toContain('assistant_message');

    const assistantMessage = all.find((e) => e.type === 'assistant_message');
    expect((assistantMessage?.payload as { text: string }).text).toBe('Hello world');
    expect(sessions.findById(created.id)?.status).toBe('IDLE');
    expect(sessions.findById(created.id)?.preview).toBe('Hello');
  });

  it('run passes escape hatches, cwd, and model to Agent.create (case B)', async () => {
    const { sdk, createCalls } = makeStubSdk({ waitResult: 'ok' });
    provider.sdkOverride = sdk as never;
    process.env.CURSOR_API_KEY = 'cursor_test_key';

    const created = sessions.create({ prompt: 'task', provider: 'cursor', workspace: '/tmp/ws' });
    await provider.run(created.id, created.prompt, {
      emit: () => {},
      workspace: '/tmp/ws',
      model: 'cursor:composer-2',
    });

    const args = createCalls[0] as {
      apiKey: string;
      model: { id: string };
      local: { cwd: string; useHttp1ForAgent: boolean; store: { dir: string } };
    };
    expect(args.local.cwd).toBe('/tmp/ws');
    expect(args.local.useHttp1ForAgent).toBe(true);
    expect(args.local.store).toBeInstanceOf(sdk.JsonlLocalAgentStore);
    expect(args.model.id).toBe('composer-2');
    expect(args.apiKey).toBe('cursor_test_key');
  });

  it('run reaches ERROR when wait status is error (case C)', async () => {
    const { sdk } = makeStubSdk({ waitStatus: 'error' });
    provider.sdkOverride = sdk as never;
    process.env.CURSOR_API_KEY = 'cursor_test_key';

    const created = sessions.create({ prompt: 'fail', provider: 'cursor' });
    await provider.run(created.id, created.prompt, { emit: () => {} });

    expect(sessions.findById(created.id)?.status).toBe('ERROR');
    const errorEvent = events.list(created.id).find((e) => e.type === 'error');
    expect((errorEvent?.payload as { message: string }).message).toContain('Cursor run stub-run-1 failed');
  });

  it('run reaches ERROR when Agent.create throws (case D)', async () => {
    const { sdk } = makeStubSdk({ createThrows: new Error('Invalid User API Key') });
    provider.sdkOverride = sdk as never;
    process.env.CURSOR_API_KEY = 'cursor_test_key';

    const created = sessions.create({ prompt: 'auth fail', provider: 'cursor' });
    await provider.run(created.id, created.prompt, { emit: () => {} });

    expect(sessions.findById(created.id)?.status).toBe('ERROR');
    const errorEvent = events.list(created.id).find((e) => e.type === 'error');
    expect((errorEvent?.payload as { message: string }).message).toContain('Invalid User API Key');
  });

  it('steer reuses the same agent handle (case E)', async () => {
    const { sdk, createCalls, sendCalls } = makeStubSdk({ waitResult: 'ok' });
    provider.sdkOverride = sdk as never;
    process.env.CURSOR_API_KEY = 'cursor_test_key';

    const created = sessions.create({ prompt: 'first', provider: 'cursor' });
    await provider.run(created.id, created.prompt, { emit: () => {} });
    await provider.steer(created.id, 'second', { emit: () => {} });

    expect(createCalls).toHaveLength(1);
    expect(sendCalls).toEqual(['first', 'second']);
    expect(events.list(created.id).some((e) => e.type === 'steer_message')).toBe(true);
  });

  it('assistant_message falls back to accumulatedText when result.result is missing (case F)', async () => {
    const { sdk } = makeStubSdk({
      deltaUpdates: [{ type: 'text-delta', text: 'Fallback' }],
      waitResult: undefined,
    });
    provider.sdkOverride = sdk as never;
    process.env.CURSOR_API_KEY = 'cursor_test_key';

    const created = sessions.create({ prompt: 'fallback', provider: 'cursor' });
    await provider.run(created.id, created.prompt, { emit: () => {} });

    const assistantMessage = events.list(created.id).find((e) => e.type === 'assistant_message');
    expect((assistantMessage?.payload as { text: string }).text).toBe('Fallback');
  });

  it('emits one assistant_delta per text-delta token via onDelta (token streaming)', async () => {
    const { sdk, sendOptionsCalls } = makeStubSdk({
      deltaUpdates: [
        { type: 'text-delta', text: 'P' },
        { type: 'text-delta', text: 'ONG' },
      ],
      waitResult: 'PONG',
    });
    provider.sdkOverride = sdk as never;
    process.env.CURSOR_API_KEY = 'cursor_test_key';

    const created = sessions.create({ prompt: 'ping', provider: 'cursor' });
    const emitted: { type: string; payload: unknown }[] = [];
    const emit: EventEmitter = (event) => emitted.push(event);

    await provider.run(created.id, created.prompt, { emit });

    const deltas = events.list(created.id).filter((e) => e.type === 'assistant_delta');
    expect(deltas.map((e) => (e.payload as { delta: string }).delta)).toEqual(['P', 'ONG']);
    expect(sessions.findById(created.id)?.preview).toBe('PONG');
    // The provider must pass an onDelta handler to agent.send.
    expect((sendOptionsCalls[0] as { onDelta?: unknown }).onDelta).toBeInstanceOf(Function);
  });

  it('maps tool-call-started/completed to tool_start/tool_end via onDelta', async () => {
    const { sdk } = makeStubSdk({
      deltaUpdates: [
        { type: 'tool-call-started', toolCall: { type: 'bash' } },
        { type: 'tool-call-completed', toolCall: { type: 'bash' } },
      ],
      waitResult: 'done',
    });
    provider.sdkOverride = sdk as never;
    process.env.CURSOR_API_KEY = 'cursor_test_key';

    const created = sessions.create({ prompt: 'run it', provider: 'cursor' });
    await provider.run(created.id, created.prompt, { emit: () => {} });

    const all = events.list(created.id);
    const toolStart = all.find((e) => e.type === 'tool_start');
    const toolEnd = all.find((e) => e.type === 'tool_end');
    expect((toolStart?.payload as { tool: string }).tool).toBe('bash');
    expect((toolEnd?.payload as { tool: string }).tool).toBe('bash');
  });

  it('maps tool-call-completed error status to tool_end isError=true', async () => {
    const { sdk } = makeStubSdk({
      deltaUpdates: [
        { type: 'tool-call-completed', toolCall: { type: 'bash', status: 'error' } },
      ],
      waitResult: 'done',
    });
    provider.sdkOverride = sdk as never;
    process.env.CURSOR_API_KEY = 'cursor_test_key';

    const created = sessions.create({ prompt: 'run it', provider: 'cursor' });
    await provider.run(created.id, created.prompt, { emit: () => {} });

    const toolEnd = events.list(created.id).find((e) => e.type === 'tool_end');
    expect((toolEnd?.payload as { isError: boolean }).isError).toBe(true);
  });

  it('ignores non-text/non-tool interaction updates', async () => {
    const { sdk } = makeStubSdk({
      deltaUpdates: [
        { type: 'thinking-delta', text: 'pondering' },
        { type: 'token-delta', tokens: 5 },
        { type: 'step-started' },
      ],
      waitResult: 'ok',
    });
    provider.sdkOverride = sdk as never;
    process.env.CURSOR_API_KEY = 'cursor_test_key';

    const created = sessions.create({ prompt: 'think', provider: 'cursor' });
    await provider.run(created.id, created.prompt, { emit: () => {} });

    const all = events.list(created.id);
    expect(all.filter((e) => e.type === 'assistant_delta')).toHaveLength(0);
    expect(all.filter((e) => e.type === 'tool_start')).toHaveLength(0);
  });
});
