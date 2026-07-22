import { afterEach, beforeEach, describe } from 'bun:test';
import { Test, type TestingModule } from '@nestjs/testing';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  DevinAcpClientLike,
  DevinAcpError,
  DevinAcpNotification,
  DevinAcpRequest,
} from '../../../src/agents/providers/devin-acp.client';
import { DevinAgentProvider } from '../../../src/agents/providers/devin-agent.provider';
import { DatabaseModule } from '../../../src/db/database.module';
import { EventsRepository } from '../../../src/sessions/persistence/events.repository';
import { SessionsRepository } from '../../../src/sessions/persistence/sessions.repository';
import { SessionsPersistenceModule } from '../../../src/sessions/sessions.persistence.module';
import { SettingsModule } from '../../../src/settings/settings.module';
import { describeAgentProviderContract } from './provider-contract.suite';

type Script = 'success' | 'error' | 'interrupt';

class FakeDevinClient implements DevinAcpClientLike {
  script: Script = 'success';
  deltas: string[] = [];
  readonly methods: string[] = [];
  private rejectPrompt?: (error: Error) => void;
  private notifications = new Set<(notification: DevinAcpNotification) => void>();
  private requests = new Set<(request: DevinAcpRequest) => void>();
  private closes = new Set<(error: Error) => void>();

  async initialize(): Promise<void> {}
  async request<T>(method: string): Promise<T> {
    this.methods.push(method);
    if (method === 'session/new') return { sessionId: 'devin-contract-1' } as T;
    if (method === 'session/load') return {} as T;
    if (method === 'session/set_config_option') return {} as T;
    if (method === 'session/prompt') {
      if (this.script === 'error') throw new Error('devin turn failed');
      if (this.script === 'interrupt') {
        return new Promise<T>((_resolve, reject) => { this.rejectPrompt = reject; });
      }
      queueMicrotask(() => {
        for (const delta of this.deltas) {
          this.emit({
            method: 'session/update',
            params: {
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: delta },
              },
            },
          });
        }
        this.emit({ method: '_cognition.ai/agent_stopped', params: {} });
      });
      return {} as T;
    }
    if (method === 'session/cancel') {
      this.rejectPrompt?.(new Error('Request cancelled'));
      return {} as T;
    }
    throw new Error(`Unexpected Devin request ${method}`);
  }
  onNotification(listener: (notification: DevinAcpNotification) => void): () => void {
    this.notifications.add(listener);
    return () => this.notifications.delete(listener);
  }
  onServerRequest(listener: (request: DevinAcpRequest) => void): () => void {
    this.requests.add(listener);
    return () => this.requests.delete(listener);
  }
  onClose(listener: (error: Error) => void): () => void {
    this.closes.add(listener);
    return () => this.closes.delete(listener);
  }
  respond(): void {}
  respondError(_id: string | number, _error: DevinAcpError): void {}
  close(): void {}
  emit(notification: DevinAcpNotification): void {
    for (const listener of this.notifications) listener(notification);
  }
}

describe('DevinAgentProvider contract', () => {
  let module: TestingModule;
  let provider: DevinAgentProvider;
  let sessions: SessionsRepository;
  let events: EventsRepository;
  let client: FakeDevinClient;
  let dataDir: string;

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-devin-contract-'));
    process.env.NUNCIO_DATA_DIR = dataDir;
    module = await Test.createTestingModule({
      imports: [DatabaseModule, SessionsPersistenceModule, SettingsModule],
      providers: [DevinAgentProvider],
    }).compile();
    provider = module.get(DevinAgentProvider);
    sessions = module.get(SessionsRepository);
    events = module.get(EventsRepository);
    client = new FakeDevinClient();
    provider.clientFactory = () => client;
  });

  afterEach(async () => {
    await module.close();
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.NUNCIO_DATA_DIR;
  });

  describeAgentProviderContract('devin', () => ({
    provider,
    sessions,
    events,
    runContext: { cwd: '/tmp/project', model: 'devin:swe-1-7' },
    createSession: (prompt) =>
      sessions.create({ prompt, provider: 'devin', model: 'devin:swe-1-7' }),
    successDeltas: ['Devin ', 'stream 世界'],
    successFinalText: 'Devin stream 世界',
    arrangeSuccess: (deltas) => {
      client.script = 'success';
      client.deltas = deltas;
    },
    arrangeError: () => { client.script = 'error'; },
    exercisesInterrupt: true,
    arrangeAndInterrupt: async (sessionId, emit) => {
      client.script = 'interrupt';
      const run = provider.run(sessionId, 'interruptible', {
        cwd: '/tmp/project',
        model: 'devin:swe-1-7',
        emit,
      });
      const started = Date.now();
      while (!client.methods.includes('session/prompt')) {
        if (Date.now() - started > 1_000) throw new Error('Devin turn did not start');
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      await provider.interrupt(sessionId);
      await run;
    },
  }));
});
