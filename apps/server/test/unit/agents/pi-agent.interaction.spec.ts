import { beforeAll, afterAll, beforeEach, describe, it, expect, mock } from 'bun:test';
import { Test, TestingModule } from '@nestjs/testing';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PiAgentProvider } from '../../../src/agents/providers/pi-agent.provider';
import { DatabaseModule } from '../../../src/db/database.module';
import { EventsRepository } from '../../../src/sessions/persistence/events.repository';
import { SessionsRepository } from '../../../src/sessions/persistence/sessions.repository';
import { SessionsPersistenceModule } from '../../../src/sessions/sessions.persistence.module';
import { SettingsModule } from '../../../src/settings/settings.module';

let promptCalls: Array<{ text: string; options: unknown }> = [];
let promptBehavior: ((text: string, options?: unknown) => Promise<void>) | null = null;
let isStreaming = false;
let subscribedHandler: ((event: { type: string; [key: string]: unknown }) => void) | null = null;
const steerMock = mock(async (_text: string, _images?: unknown) => undefined);

const sampleQuestion = {
  id: 'q1',
  prompt: 'Which lane?',
  options: [{ id: 'a', label: 'Frontend', description: 'UI work' }],
};

mock.module('@earendil-works/pi-coding-agent', () => ({
  AuthStorage: { create: () => ({}) },
  ModelRegistry: {
    create: () => ({
      getError: () => undefined,
      getAvailable: () => [],
      getProviderDisplayName: (provider: string) => provider,
      find: () => undefined,
    }),
  },
  SessionManager: {
    open: (path: string, sessionDir: undefined, cwd?: string) => ({ kind: 'open', path, sessionDir, cwd }),
  },
  createAgentSession: () => ({
    session: {
      sessionFile: '/tmp/fake-pi/interaction-session.jsonl',
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
      abort: async () => undefined,
      steer: steerMock,
      setModel: async () => undefined,
      setThinkingLevel: () => undefined,
    },
  }),
  SettingsManager: { create: () => ({}) },
  DefaultResourceLoader: class {
    async reload() {}
  },
  getAgentDir: () => '/tmp/fake-pi',
}));

describe('PiAgentProvider interaction', () => {
  let module: TestingModule;
  let provider: PiAgentProvider;
  let sessions: SessionsRepository;
  let events: EventsRepository;
  let dataDir: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-pi-interaction-'));
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
  });

  beforeEach(() => {
    promptCalls = [];
    promptBehavior = null;
    isStreaming = false;
    subscribedHandler = null;
    steerMock.mockClear();
    provider.bustCache();
  });

  it('supportsInteraction returns true', () => {
    expect(provider.supportsInteraction?.()).toBe(true);
  });

  it('emits user_input_requested instead of tool events for an interactive tool call', async () => {
    const emitted: Array<{ type: string; payload: Record<string, unknown> }> = [];
    promptBehavior = async () => {
      subscribedHandler?.({
        type: 'tool_execution_start',
        toolCallId: 'call-aq-1',
        toolName: 'ask_question',
        args: { title: 'Need your input', questions: [sampleQuestion] },
      });
      subscribedHandler?.({
        type: 'tool_execution_end',
        toolCallId: 'call-aq-1',
        toolName: 'ask_question',
        result: 'cancelled',
        isError: false,
      });
      subscribedHandler?.({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', delta: 'Waiting for your answer.' },
      });
    };
    const created = sessions.create({ prompt: 'ask me something', provider: 'pi' });

    await provider.run(created.id, created.prompt, {
      emit: (event) => emitted.push(event as { type: string; payload: Record<string, unknown> }),
    });

    const requested = emitted.find((e) => e.type === 'user_input_requested');
    expect(requested?.payload).toEqual({
      requestId: 'call-aq-1',
      title: 'Need your input',
      questions: [sampleQuestion],
    });
    expect(emitted.some((e) => e.type === 'tool_start' && e.payload.callId === 'call-aq-1')).toBe(false);
    expect(emitted.some((e) => e.type === 'tool_end' && e.payload.callId === 'call-aq-1')).toBe(false);
  });

  it('falls back to plain tool events when interactive tool args have no questions', async () => {
    const emitted: Array<{ type: string; payload: Record<string, unknown> }> = [];
    promptBehavior = async () => {
      subscribedHandler?.({
        type: 'tool_execution_start',
        toolCallId: 'call-aq-2',
        toolName: 'ask_question',
        args: { note: 'not a questionnaire' },
      });
      subscribedHandler?.({
        type: 'tool_execution_end',
        toolCallId: 'call-aq-2',
        toolName: 'ask_question',
        result: 'ok',
        isError: false,
      });
    };
    const created = sessions.create({ prompt: 'odd args', provider: 'pi' });

    await provider.run(created.id, created.prompt, {
      emit: (event) => emitted.push(event as { type: string; payload: Record<string, unknown> }),
    });

    expect(emitted.some((e) => e.type === 'user_input_requested')).toBe(false);
    expect(emitted.some((e) => e.type === 'tool_start' && e.payload.callId === 'call-aq-2')).toBe(true);
    expect(emitted.some((e) => e.type === 'tool_end' && e.payload.callId === 'call-aq-2')).toBe(true);
  });

  it('submitInteraction on an idle session emits resolved then re-enters the run with the answer', async () => {
    promptBehavior = async () => {
      subscribedHandler?.({
        type: 'tool_execution_start',
        toolCallId: 'call-aq-3',
        toolName: 'ask_question',
        args: { questions: [sampleQuestion] },
      });
      subscribedHandler?.({
        type: 'tool_execution_end',
        toolCallId: 'call-aq-3',
        toolName: 'ask_question',
        result: 'cancelled',
        isError: false,
      });
    };
    const created = sessions.create({ prompt: 'pick a lane', provider: 'pi' });
    await provider.run(created.id, created.prompt, { emit: () => {} });
    promptBehavior = null;

    await provider.submitInteraction!(
      created.id,
      'call-aq-3',
      { answers: [{ questionId: 'q1', selectedOptionIds: ['a'] }], resolvedBy: 'user' },
      { emit: () => {} },
    );

    const stored = events.list(created.id);
    const resolved = stored.find((e) => e.type === 'user_input_resolved');
    expect(resolved?.payload).toEqual({
      requestId: 'call-aq-3',
      resolvedBy: 'user',
      answers: [{ questionId: 'q1', selectedOptionIds: ['a'] }],
    });
    expect(stored.some((e) => e.type === 'steer_message')).toBe(true);
    expect(promptCalls[1]).toEqual({
      text: 'Option 1 \u2014 Frontend',
      options: { streamingBehavior: 'steer' },
    });
    expect(sessions.findById(created.id)?.status).toBe('IDLE');
  });

  it('submitInteraction during a live streaming run queues the answer via session.steer', async () => {
    promptBehavior = async () => {
      subscribedHandler?.({
        type: 'tool_execution_start',
        toolCallId: 'call-aq-4',
        toolName: 'ask_question',
        args: { questions: [sampleQuestion] },
      });
    };
    const created = sessions.create({ prompt: 'streaming question', provider: 'pi' });
    await provider.run(created.id, created.prompt, { emit: () => {} });
    promptBehavior = null;

    isStreaming = true;
    await provider.submitInteraction!(
      created.id,
      'call-aq-4',
      { answers: [{ questionId: 'q1', selectedOptionIds: ['a'] }], resolvedBy: 'user' },
      { emit: () => {} },
    );

    expect(steerMock).toHaveBeenCalledTimes(1);
    expect(steerMock.mock.calls[0]?.[0]).toBe('Option 1 \u2014 Frontend');
    expect(promptCalls).toHaveLength(1);
    const stored = events.list(created.id);
    expect(stored.some((e) => e.type === 'user_input_resolved')).toBe(true);
    expect(stored.some((e) => e.type === 'steer_message')).toBe(true);
  });

  it('submitInteraction rejects an unknown or already-resolved requestId', async () => {
    const created = sessions.create({ prompt: 'nothing pending', provider: 'pi' });

    await expect(
      provider.submitInteraction!(
        created.id,
        'no-such-request',
        { answers: [{ questionId: 'q1', selectedOptionIds: ['a'] }], resolvedBy: 'user' },
        { emit: () => {} },
      ),
    ).rejects.toThrow(/No pending user input request/);

    events.append(created.id, 'user_input_requested', {
      requestId: 'dup',
      questions: [sampleQuestion],
    });
    events.append(created.id, 'user_input_resolved', { requestId: 'dup', resolvedBy: 'user' });

    await expect(
      provider.submitInteraction!(
        created.id,
        'dup',
        { answers: [{ questionId: 'q1', selectedOptionIds: ['a'] }], resolvedBy: 'user' },
        { emit: () => {} },
      ),
    ).rejects.toThrow(/No pending user input request/);
  });
});
