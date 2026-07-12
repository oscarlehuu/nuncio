import { beforeAll, afterAll, beforeEach, describe, mock } from 'bun:test';
import { Test, TestingModule } from '@nestjs/testing';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { EventEmitter } from '../../../src/agents/agents.types';
import { PiAgentProvider } from '../../../src/agents/providers/pi-agent.provider';
import { DatabaseModule } from '../../../src/db/database.module';
import { EventsRepository } from '../../../src/sessions/persistence/events.repository';
import { SessionsRepository } from '../../../src/sessions/persistence/sessions.repository';
import { SessionsPersistenceModule } from '../../../src/sessions/sessions.persistence.module';
import { SettingsModule } from '../../../src/settings/settings.module';
import { describeAgentProviderContract } from './provider-contract.suite';

type PiEvent = { type: string; [key: string]: unknown };

let subscribedHandler: ((event: PiEvent) => void) | null = null;
let isStreaming = false;
let promptBehavior: (() => Promise<void>) | null = null;
const abortMock = mock(async () => {
  isStreaming = false;
});

function registryModel(provider = 'anthropic', id = 'model-1') {
  return {
    provider,
    id,
    name: `Model ${id}`,
    reasoning: true,
    thinkingLevelMap: { off: null, low: 'low', medium: 'medium', high: 'high' },
  };
}

// Stub the Pi SDK at the adapter boundary — no real ~/.pi read/write, no network.
mock.module('@earendil-works/pi-coding-agent', () => ({
  AuthStorage: { create: () => ({}) },
  ModelRegistry: {
    create: () => ({
      getAvailable: () => [{ provider: 'anthropic', id: 'model-0', name: 'Model 0' }],
      getProviderDisplayName: (provider: string) => provider,
      find: (provider: string, id: string) =>
        provider === 'anthropic' ? registryModel(provider, id) : undefined,
    }),
  },
  SessionManager: {
    open: (path: string) => ({ kind: 'open', path }),
    inMemory: () => ({ kind: 'inMemory' }),
  },
  createAgentSession: () => ({
    session: {
      sessionFile: '/tmp/fake-pi-contract/session.jsonl',
      get model() {
        return registryModel();
      },
      get thinkingLevel() {
        return 'medium';
      },
      get isStreaming() {
        return isStreaming;
      },
      subscribe: (handler: (event: PiEvent) => void) => {
        subscribedHandler = handler;
        return () => {
          if (subscribedHandler === handler) subscribedHandler = null;
        };
      },
      prompt: async () => {
        await promptBehavior?.();
      },
      abort: abortMock,
      steer: async () => undefined,
      setModel: async () => undefined,
      setThinkingLevel: () => undefined,
    },
  }),
  SettingsManager: { create: () => ({}) },
  DefaultResourceLoader: class {
    async reload() {}
  },
  getAgentDir: () => '/tmp/fake-pi-contract',
}));

describe('PiAgentProvider contract', () => {
  let module: TestingModule;
  let provider: PiAgentProvider;
  let sessions: SessionsRepository;
  let events: EventsRepository;
  let dataDir: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-pi-contract-'));
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
    subscribedHandler = null;
    isStreaming = false;
    promptBehavior = null;
    abortMock.mockClear();
    provider.bustCache();
  });

  describeAgentProviderContract('pi', () => ({
    provider,
    sessions,
    events,
    createSession: (prompt) => sessions.create({ prompt, provider: 'pi' }),
    successDeltas: ['Streaming ', 'tokens 世界'],
    successFinalText: 'Streaming tokens 世界',
    arrangeSuccess: (deltas, finalText) => {
      promptBehavior = async () => {
        for (const delta of deltas) {
          subscribedHandler?.({
            type: 'message_update',
            assistantMessageEvent: { type: 'text_delta', delta },
          });
        }
        subscribedHandler?.({
          type: 'message_end',
          message: {
            role: 'assistant',
            stopReason: 'stop',
            content: [{ type: 'text', text: finalText }],
          },
        });
      };
    },
    arrangeError: () => {
      // Pi surfaces a turn error via a message_end with stopReason 'error'.
      promptBehavior = async () => {
        subscribedHandler?.({
          type: 'message_end',
          message: {
            role: 'assistant',
            stopReason: 'error',
            errorMessage: 'pi turn failed',
            content: [],
          },
        });
      };
    },
    exercisesInterrupt: true,
    arrangeAndInterrupt: async (sessionId, emit: EventEmitter) => {
      // A run that hangs streaming until interrupt() aborts it; the provider
      // treats the abort-triggered rejection as a clean cancel → IDLE.
      let rejectPrompt: (error: Error) => void = () => undefined;
      const promptStarted = new Promise<void>((resolve) => {
        promptBehavior = async () =>
          new Promise<void>((_resolve, reject) => {
            rejectPrompt = reject;
            resolve();
          });
      });
      isStreaming = true;
      const created = sessions.findById(sessionId)!;
      const run = provider.run(sessionId, created.prompt, { emit });
      await promptStarted;
      await provider.interrupt(sessionId);
      rejectPrompt(new Error('aborted by user'));
      await run;
    },
  }));
});
