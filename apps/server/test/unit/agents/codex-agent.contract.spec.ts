import { beforeEach, afterEach, describe } from 'bun:test';
import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CodexAgentProvider } from '../../../src/agents/providers/codex-agent.provider';
import type {
  CodexAppServerClientLike,
  CodexServerNotification,
  CodexServerRequest,
} from '../../../src/agents/providers/codex-app-server.client';
import { DatabaseModule } from '../../../src/db/database.module';
import { EventsRepository } from '../../../src/sessions/persistence/events.repository';
import { SessionsRepository } from '../../../src/sessions/persistence/sessions.repository';
import { SessionsPersistenceModule } from '../../../src/sessions/sessions.persistence.module';
import { SettingsModule } from '../../../src/settings/settings.module';
import { describeAgentProviderContract } from './provider-contract.suite';

/**
 * Codex app-server stub scriptable per contract scenario. `run()` resolves once
 * the turn completes, so each scenario arranges the turn/start reply (deltas +
 * terminal status) before the contract calls run().
 */
class FakeCodexClient extends EventEmitter implements CodexAppServerClientLike {
  closed = false;
  private script: { deltas: string[]; fail: boolean } = { deltas: [], fail: false };
  private turnSeq = 0;

  arrange(deltas: string[], fail: boolean): void {
    this.script = { deltas, fail };
  }

  async initialize(): Promise<void> {}

  async request<T>(method: string, params: unknown): Promise<T> {
    if (method === 'thread/start') {
      queueMicrotask(() =>
        this.emitNotification({ method: 'thread/started', params: { thread: { id: 'codex-thread-1' } } }),
      );
      return { thread: { id: 'codex-thread-1' } } as T;
    }
    if (method === 'thread/resume') {
      return { thread: { id: (params as { threadId: string }).threadId } } as T;
    }
    if (method === 'turn/start' || method === 'turn/steer') {
      const turnId = `turn-${++this.turnSeq}`;
      queueMicrotask(() => {
        this.emitNotification({ method: 'turn/started', params: { turn: { id: turnId } } });
        for (const delta of this.script.deltas) {
          // Same itemId across deltas → no item-boundary paragraph break, so the
          // contract's coalescing assertion stays provider-agnostic.
          this.emitNotification({
            method: 'item/agentMessage/delta',
            params: { threadId: 'codex-thread-1', turnId, itemId: 'item-1', delta },
          });
        }
        this.emitNotification({
          method: 'turn/completed',
          params: {
            turn: this.script.fail
              ? { id: turnId, status: 'failed', error: { message: 'codex turn failed' } }
              : { id: turnId, status: 'completed' },
          },
        });
      });
      return { turn: { id: turnId } } as T;
    }
    if (method === 'turn/interrupt') return {} as T;
    throw new Error(`Unexpected Codex request ${method}`);
  }

  onNotification(listener: (notification: CodexServerNotification) => void): () => void {
    this.on('notification', listener);
    return () => this.off('notification', listener);
  }
  onServerRequest(listener: (request: CodexServerRequest) => void): () => void {
    this.on('serverRequest', listener);
    return () => this.off('serverRequest', listener);
  }
  onClose(listener: (error: Error) => void): () => void {
    this.on('close', listener);
    return () => this.off('close', listener);
  }
  respond(): void {}
  close(): void {
    this.closed = true;
  }
  emitNotification(notification: CodexServerNotification): void {
    this.emit('notification', notification);
  }
}

describe('CodexAgentProvider contract', () => {
  let module: TestingModule;
  let provider: CodexAgentProvider;
  let sessions: SessionsRepository;
  let events: EventsRepository;
  let dataDir: string;
  let fakeClient: FakeCodexClient;

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-codex-contract-'));
    process.env.NUNCIO_DATA_DIR = dataDir;

    module = await Test.createTestingModule({
      imports: [DatabaseModule, SessionsPersistenceModule, SettingsModule],
      providers: [CodexAgentProvider],
    }).compile();

    sessions = module.get(SessionsRepository);
    events = module.get(EventsRepository);
    provider = module.get(CodexAgentProvider);
    fakeClient = new FakeCodexClient();
    provider.clientFactory = () => fakeClient;
    provider.cliCandidatePaths = ['/opt/nuncio/bin/codex'];
    provider.commandRunner = async () => ({ status: 0, stdout: 'codex-cli 0.142.5', stderr: '' });
  });

  afterEach(async () => {
    await module.close();
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.NUNCIO_DATA_DIR;
  });

  describeAgentProviderContract('codex', () => ({
    provider,
    sessions,
    events,
    runContext: { cwd: '/tmp/project', model: 'codex:gpt-5.5' },
    createSession: (prompt) =>
      sessions.create({ prompt, provider: 'codex', model: 'codex:gpt-5.5' }),
    successDeltas: ['Codex ', 'stream 世界'],
    successFinalText: 'Codex stream 世界',
    arrangeSuccess: (deltas) => fakeClient.arrange(deltas, false),
    arrangeError: () => fakeClient.arrange([], true),
    // Codex declares interrupt off (dispose issues turn/interrupt, but no
    // interrupt() method surfaces the capability) — declared-off contract leg.
    exercisesInterrupt: false,
  }));
});
