import { beforeAll, afterAll, beforeEach, describe, it, expect, mock } from 'bun:test';
import { Test, TestingModule } from '@nestjs/testing';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PiAgentProvider } from '../../../src/agents/providers/pi-agent.provider';
import { DatabaseModule } from '../../../src/db/database.module';
import { SessionsRepository } from '../../../src/sessions/persistence/sessions.repository';
import { SessionsPersistenceModule } from '../../../src/sessions/sessions.persistence.module';
import { SettingsModule } from '../../../src/settings/settings.module';

let availableModelCount = 0;
let fakeSessionFile = '/tmp/fake-pi/session.jsonl';
let promptCalls: Array<{ text: string; options: unknown }> = [];
let promptBehavior: ((text: string, options?: unknown) => Promise<void>) | null = null;
let isStreaming = false;
let subscribedHandler: ((event: { type: string; [key: string]: unknown }) => void) | null = null;
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
    thinkingLevelMap: { off: null, low: 'low', medium: 'medium', high: 'high' },
  };
}

mock.module('@earendil-works/pi-coding-agent', () => ({
  AuthStorage: { create: () => ({}) },
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
    open: (path: string, sessionDir: undefined, cwd?: string) => ({ kind: 'open', path, sessionDir, cwd }),
  },
  createAgentSession: () => ({
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
  }),
  getAgentDir: () => '/tmp/fake-pi',
}));

describe('PiAgentProvider', () => {
  let module: TestingModule;
  let provider: PiAgentProvider;
  let sessions: SessionsRepository;
  let dataDir: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-pi-provider-'));
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
  });

  beforeEach(() => {
    availableModelCount = 0;
    fakeSessionFile = '/tmp/fake-pi/session.jsonl';
    promptCalls = [];
    promptBehavior = null;
    isStreaming = false;
    subscribedHandler = null;
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

  it('dispose is a no-op for an unknown session', () => {
    expect(() => provider.dispose('no-such-session')).not.toThrow();
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
});
