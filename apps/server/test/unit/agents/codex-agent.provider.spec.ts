import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
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
import { SettingsService } from '../../../src/settings/settings.service';

class FakeCodexClient extends EventEmitter implements CodexAppServerClientLike {
  readonly requests: Array<{ method: string; params: unknown }> = [];
  readonly responses: Array<{ id: string | number; result: unknown }> = [];
  closed = false;
  autoCompleteTurn = true;
  modelListResponse: unknown = {
    data: [
      {
        id: 'gpt-5.5',
        displayName: 'GPT-5.5',
        description: 'Codex model',
        supportedReasoningEfforts: [
          { reasoningEffort: 'medium' },
          { reasoningEffort: 'xhigh' },
        ],
        defaultReasoningEffort: 'medium',
        supportsFastMode: true,
      },
    ],
  };

  async initialize(): Promise<void> {
    this.requests.push({
      method: 'initialize',
      params: {
        clientInfo: { name: 'nuncio', version: '0.1.0' },
        experimentalApi: true,
      },
    });
  }

  async request<T>(method: string, params: unknown): Promise<T> {
    this.requests.push({ method, params });

    if (method === 'thread/start') {
      queueMicrotask(() => {
        this.emitNotification({
          method: 'thread/started',
          params: { thread: { id: 'codex-thread-1' } },
        });
      });
      return { thread: { id: 'codex-thread-1' } } as T;
    }

    if (method === 'thread/resume') {
      return { thread: { id: (params as { threadId: string }).threadId } } as T;
    }

    if (method === 'model/list') {
      return this.modelListResponse as T;
    }

    if (method === 'turn/start') {
      queueMicrotask(() => {
        this.emitNotification({
          method: 'turn/started',
          params: { turn: { id: 'turn-1' } },
        });
        this.emitServerRequest({
          id: 'approval-1',
          method: 'exec/approval',
          params: { command: 'git status' },
        });
        this.emitNotification({
          method: 'item/agentMessage/delta',
          params: { threadId: 'codex-thread-1', turnId: 'turn-1', delta: 'Hello' },
        });
        if (this.autoCompleteTurn) {
          this.completeTurn();
        }
      });
      return { turn: { id: 'turn-1' } } as T;
    }

    if (method === 'turn/interrupt') {
      return {} as T;
    }

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

  respond(id: string | number, result: unknown): void {
    this.responses.push({ id, result });
  }

  close(): void {
    this.closed = true;
  }

  emitNotification(notification: CodexServerNotification): void {
    this.emit('notification', notification);
  }

  emitServerRequest(request: CodexServerRequest): void {
    this.emit('serverRequest', request);
  }

  emitClose(error = new Error('codex app-server exited')): void {
    this.emit('close', error);
  }

  completeTurn(): void {
    this.emitNotification({
      method: 'turn/completed',
      params: { turn: { id: 'turn-1', status: 'completed' } },
    });
  }
}

describe('CodexAgentProvider', () => {
  let module: TestingModule;
  let provider: CodexAgentProvider;
  let sessions: SessionsRepository;
  let events: EventsRepository;
  let dataDir: string;
  let fakeClient: FakeCodexClient;

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-codex-provider-'));
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
  });

  afterEach(async () => {
    await module.close();
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.NUNCIO_DATA_DIR;
  });

  it('starts a Codex thread, streams deltas, and persists the provider thread id', async () => {
    const created = sessions.create({
      id: 'session-1',
      prompt: 'Say hello',
      provider: 'codex',
      model: 'codex:gpt-5.5',
    });
    const emitted: Array<{ type: string; payload: unknown }> = [];

    await provider.run(created.id, created.prompt, {
      emit: (event) => emitted.push(event),
      cwd: '/tmp/project',
      model: created.model,
    });

    const saved = sessions.findById(created.id);
    expect(saved?.providerThreadId).toBe('codex-thread-1');
    expect(saved?.providerActiveTurnId).toBeNull();
    expect(saved?.status).toBe('IDLE');
    expect(events.list(created.id).map((event) => event.type)).toContain('assistant_delta');
    expect(events.list(created.id).map((event) => event.type)).toContain('assistant_message');
    expect(emitted.some((event) => event.type === 'assistant_delta')).toBe(true);
    expect(sessions.findById(created.id)?.preview).toBe('Hello');

    expect(fakeClient.requests).toContainEqual({
      method: 'thread/start',
      params: {
        model: 'gpt-5.5',
        cwd: '/tmp/project',
        approvalPolicy: 'never',
        sandbox: 'danger-full-access',
        experimentalRawEvents: false,
      },
    });
    expect(fakeClient.requests).toContainEqual({
      method: 'turn/start',
      params: {
        threadId: 'codex-thread-1',
        input: [{ type: 'text', text: 'Say hello', text_elements: [] }],
        model: 'gpt-5.5',
        approvalPolicy: 'never',
        sandboxPolicy: { type: 'dangerFullAccess' },
      },
    });
  });

  it('lists Codex reasoning effort and fast priority options', async () => {
    provider.commandRunner = async () => ({
      status: 0,
      stdout: 'ok',
      stderr: '',
    });

    const providers = await provider.listModels();
    const model = providers[0]?.groups?.[0]?.models?.[0];

    expect(model?.id).toBe('codex:gpt-5.5');
    expect(model?.options).toContainEqual({
      id: 'reasoningEffort',
      label: 'Reasoning',
      type: 'select',
      defaultValue: 'medium',
      options: [
        { id: 'medium', label: 'medium', isDefault: true },
        { id: 'xhigh', label: 'xhigh', isDefault: false },
      ],
    });
    expect(model?.options).toContainEqual({
      id: 'fast',
      label: 'Priority',
      type: 'boolean',
      defaultValue: false,
    });
  });

  it('forwards Codex reasoning effort and fast priority to turn/start', async () => {
    const created = sessions.create({
      id: 'session-options',
      prompt: 'Use fast reasoning',
      provider: 'codex',
      model: 'codex:gpt-5.5',
      modelOptions: { reasoningEffort: 'xhigh', fast: true },
    });

    await provider.run(created.id, created.prompt, {
      emit: () => undefined,
      cwd: '/tmp/project',
      model: created.model,
      modelOptions: created.modelOptions,
    });

    expect(fakeClient.requests).toContainEqual({
      method: 'turn/start',
      params: {
        threadId: 'codex-thread-1',
        input: [{ type: 'text', text: 'Use fast reasoning', text_elements: [] }],
        model: 'gpt-5.5',
        effort: 'xhigh',
        serviceTier: 'fast',
        approvalPolicy: 'never',
        sandboxPolicy: { type: 'dangerFullAccess' },
      },
    });
  });

  it('forwards Codex Spark model ids without collapsing them to the GPT-5 family name', async () => {
    const created = sessions.create({
      id: 'session-spark-model',
      prompt: 'Report the routed model',
      provider: 'codex',
      model: 'codex:gpt-5.3-codex-spark',
      modelOptions: { reasoningEffort: 'medium', fast: false },
    });

    await provider.run(created.id, created.prompt, {
      emit: () => undefined,
      cwd: '/tmp/project',
      model: created.model,
      modelOptions: created.modelOptions,
    });

    expect(fakeClient.requests).toContainEqual({
      method: 'thread/start',
      params: {
        model: 'gpt-5.3-codex-spark',
        cwd: '/tmp/project',
        approvalPolicy: 'never',
        sandbox: 'danger-full-access',
        experimentalRawEvents: false,
      },
    });
    expect(fakeClient.requests).toContainEqual({
      method: 'turn/start',
      params: {
        threadId: 'codex-thread-1',
        input: [{ type: 'text', text: 'Report the routed model', text_elements: [] }],
        model: 'gpt-5.3-codex-spark',
        effort: 'medium',
        approvalPolicy: 'never',
        sandboxPolicy: { type: 'dangerFullAccess' },
      },
    });
  });

  it('resumes a persisted Codex thread before sending a follow-up turn', async () => {
    const created = sessions.create({
      id: 'session-2',
      prompt: 'Initial prompt',
      provider: 'codex',
      model: 'codex:gpt-5.5',
    });
    sessions.updateProviderRuntimeState(created.id, {
      providerThreadId: 'codex-existing-thread',
    });

    await provider.steer(created.id, 'Continue', {
      model: created.model,
      cwd: '/tmp/project',
    });

    expect(fakeClient.requests).toContainEqual({
      method: 'thread/resume',
      params: {
        threadId: 'codex-existing-thread',
        model: 'gpt-5.5',
        cwd: '/tmp/project',
        approvalPolicy: 'never',
        sandbox: 'danger-full-access',
      },
    });
    expect(fakeClient.requests).toContainEqual({
      method: 'turn/start',
      params: {
        threadId: 'codex-existing-thread',
        input: [{ type: 'text', text: 'Continue', text_elements: [] }],
        model: 'gpt-5.5',
        approvalPolicy: 'never',
        sandboxPolicy: { type: 'dangerFullAccess' },
      },
    });
  });

  it('waits for Nuncio approval before responding to a Codex app-server request', async () => {
    fakeClient.autoCompleteTurn = false;
    const created = sessions.create({
      id: 'session-approval',
      prompt: 'Run git status',
      provider: 'codex',
      model: 'codex:gpt-5.5',
    });
    let approve!: (result: { requestId: string; decision: 'approve' }) => void;
    const approvalRequests: unknown[] = [];

    const run = provider.run(created.id, created.prompt, {
      model: created.model,
      cwd: '/tmp/project',
      requestProviderApproval: (request) => {
        approvalRequests.push(request);
        return new Promise((resolve) => {
          approve = resolve;
        });
      },
    });

    await waitUntil(() => approvalRequests.length === 1);
    expect(approvalRequests[0]).toMatchObject({
      provider: 'codex',
      method: 'exec/approval',
      params: { command: 'git status' },
    });
    expect(fakeClient.responses).toEqual([]);

    approve({ requestId: 'req-1', decision: 'approve' });
    await waitUntil(() => fakeClient.responses.length === 1);
    expect(fakeClient.responses[0]).toEqual({
      id: 'approval-1',
      result: { decision: 'approve' },
    });

    fakeClient.completeTurn();
    await run;
  });

  it('moves the session to ERROR when app-server closes while waiting for turn completion', async () => {
    fakeClient.autoCompleteTurn = false;
    const created = sessions.create({
      id: 'session-close-error',
      prompt: 'Hang until app-server exits',
      provider: 'codex',
      model: 'codex:gpt-5.5',
    });

    const run = provider.run(created.id, created.prompt, {
      model: created.model,
      cwd: '/tmp/project',
    });

    await waitUntil(() => sessions.findById(created.id)?.providerActiveTurnId === 'turn-1');
    fakeClient.emitClose(new Error('codex app-server exited'));

    await expect(settledWithin(run)).resolves.toBe('settled');
    expect(sessions.findById(created.id)?.status).toBe('ERROR');
    expect(events.list(created.id).at(-1)).toMatchObject({
      type: 'error',
      payload: { message: 'codex app-server exited' },
    });
  });

  it('settles a pending turn when disposed without marking the session as error', async () => {
    fakeClient.autoCompleteTurn = false;
    const created = sessions.create({
      id: 'session-dispose',
      prompt: 'Pause while running',
      provider: 'codex',
      model: 'codex:gpt-5.5',
    });

    const run = provider.run(created.id, created.prompt, {
      model: created.model,
      cwd: '/tmp/project',
    });

    await waitUntil(() => sessions.findById(created.id)?.providerActiveTurnId === 'turn-1');
    provider.dispose(created.id);
    sessions.updateStatus(created.id, 'PAUSED');

    await expect(settledWithin(run)).resolves.toBe('settled');
    expect(sessions.findById(created.id)?.status).toBe('PAUSED');
    expect(events.list(created.id).some((event) => event.type === 'error')).toBe(false);
  });

  it('reports availability from codex login status', async () => {
    const settings = module.get(SettingsService);
    settings.resolve = ((key: string) => {
      if (key === 'NUNCIO_CODEX_BIN') return 'codex';
      return undefined;
    }) as SettingsService['resolve'];
    provider.commandRunner = async (_command, args) => ({
      status: args[0] === 'login' ? 0 : 0,
      stdout: 'Logged in using ChatGPT',
      stderr: '',
    });

    expect(await provider.isAvailable()).toBe(true);
  });
});

async function settledWithin(promise: Promise<unknown>, timeoutMs = 100): Promise<'settled' | 'timeout'> {
  return Promise.race([
    promise.then(() => 'settled' as const),
    new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), timeoutMs)),
  ]);
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > 1000) {
      throw new Error('Timed out waiting for condition.');
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
