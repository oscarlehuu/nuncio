import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter } from 'node:events';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CodexAgentProvider } from '../../../src/agents/providers/codex-agent.provider';
import { buildAgentRuntimeEnvironment } from '../../../src/agents/runtime-environment';
import { defineTrustedRuntimeTool } from '../../../src/agents/tools/agent-runtime-tools-policy';
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
  emitApprovalRequests = true;
  suppressAutoDelta = false;
  private interruptAcknowledgement: Promise<void> | undefined;
  private acknowledgeInterrupt: (() => void) | undefined;
  threadStartName: string | null | undefined;
  threadResumeName: string | null | undefined;
  threadResumeError: Error | undefined;
  modelListResponse: unknown = {
    data: [
      {
        id: 'gpt-5.6-sol',
        displayName: 'GPT-5.6 Sol',
        description: 'Flagship GPT-5.6 model',
        supportedReasoningEfforts: [
          { reasoningEffort: 'low' },
          { reasoningEffort: 'medium' },
          { reasoningEffort: 'high' },
          { reasoningEffort: 'xhigh' },
          { reasoningEffort: 'max' },
          { reasoningEffort: 'ultra', description: 'Maximum reasoning with automatic task delegation' },
        ],
        defaultReasoningEffort: 'low',
        supportsFastMode: true,
      },
      {
        id: 'gpt-5.6-terra',
        displayName: 'GPT-5.6 Terra',
        description: 'Balanced GPT-5.6 model',
        supportedReasoningEfforts: [
          { reasoningEffort: 'low' },
          { reasoningEffort: 'medium' },
          { reasoningEffort: 'high' },
          { reasoningEffort: 'xhigh' },
          { reasoningEffort: 'max' },
          { reasoningEffort: 'ultra', description: 'Maximum reasoning with automatic task delegation' },
        ],
        defaultReasoningEffort: 'medium',
        supportsFastMode: true,
      },
      {
        id: 'gpt-5.6-luna',
        displayName: 'GPT-5.6 Luna',
        description: 'Fast GPT-5.6 model',
        supportedReasoningEfforts: [
          { reasoningEffort: 'low' },
          { reasoningEffort: 'medium' },
          { reasoningEffort: 'high' },
          { reasoningEffort: 'xhigh' },
          { reasoningEffort: 'max' },
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
        capabilities: {
          experimentalApi: true,
          requestAttestation: false,
        },
      },
    });
  }

  async request<T>(method: string, params: unknown): Promise<T> {
    this.requests.push({ method, params });

    if (method === 'thread/start') {
      queueMicrotask(() => {
        this.emitNotification({
          method: 'thread/started',
          params: { thread: this.threadPayload('codex-thread-1', this.threadStartName) },
        });
      });
      return { thread: this.threadPayload('codex-thread-1', this.threadStartName) } as T;
    }

    if (method === 'thread/resume') {
      if (this.threadResumeError) throw this.threadResumeError;
      return {
        thread: this.threadPayload((params as { threadId: string }).threadId, this.threadResumeName),
      } as T;
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
        if (this.emitApprovalRequests) {
          this.emitServerRequest({
            id: 'approval-1',
            method: 'exec/approval',
            params: { command: 'git status' },
          });
        }
        if (!this.suppressAutoDelta) {
          this.emitNotification({
            method: 'item/agentMessage/delta',
            params: { threadId: 'codex-thread-1', turnId: 'turn-1', delta: 'Hello' },
          });
        }
        if (this.autoCompleteTurn) {
          this.completeTurn();
        }
      });
      return { turn: { id: 'turn-1' } } as T;
    }

    if (method === 'turn/interrupt') {
      await this.interruptAcknowledgement;
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

  delayInterruptAcknowledgement(): void {
    this.interruptAcknowledgement = new Promise<void>((resolve) => {
      this.acknowledgeInterrupt = resolve;
    });
  }

  releaseInterruptAcknowledgement(): void {
    this.acknowledgeInterrupt?.();
  }

  private threadPayload(id: string, name: string | null | undefined): { id: string; name?: string | null } {
    return name === undefined ? { id } : { id, name };
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
    provider.cliCandidatePaths = ['/opt/nuncio/bin/codex'];
    provider.commandRunner = async () => ({
      status: 0,
      stdout: 'codex-cli 0.142.5',
      stderr: '',
    });
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

  it('maps an explicit workspace-write policy to a network-disabled Codex sandbox', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'nuncio-codex-policy-'));
    const canonicalRoot = realpathSync(workspaceRoot);
    try {
      const created = sessions.create({
        id: 'session-policy-workspace-write',
        prompt: 'Edit only this workspace',
        provider: 'codex',
        model: 'codex:gpt-5.5',
      });
      const runtimePolicy = {
        filesystem: 'workspace-write' as const,
        workspaceRoot,
        network: 'disabled' as const,
      };

      await provider.run(created.id, created.prompt, {
        model: created.model,
        cwd: workspaceRoot,
        runtimePolicy,
        tools: {
          systemPromptAppend: 'Use browser_open.',
          tools: [{ name: 'browser_open', inputSchema: {}, execute: async () => 'opened' }],
        },
      });

      expect(provider.capabilities.runtimePolicies).toContainEqual({
        filesystem: 'workspace-write',
        network: 'disabled',
      });
      expect(fakeClient.requests).toContainEqual({
        method: 'thread/start',
        params: {
          model: 'gpt-5.5',
          cwd: canonicalRoot,
          runtimeWorkspaceRoots: [canonicalRoot],
          approvalPolicy: 'never',
          sandbox: 'workspace-write',
          allowProviderModelFallback: false,
          experimentalRawEvents: false,
        },
      });
      expect(fakeClient.requests).toContainEqual({
        method: 'turn/start',
        params: {
          threadId: 'codex-thread-1',
          input: [{ type: 'text', text: 'Edit only this workspace', text_elements: [] }],
          model: 'gpt-5.5',
          cwd: canonicalRoot,
          runtimeWorkspaceRoots: [canonicalRoot],
          approvalPolicy: 'never',
          sandboxPolicy: {
            type: 'workspaceWrite',
            writableRoots: [canonicalRoot],
            networkAccess: false,
            excludeTmpdirEnvVar: true,
            excludeSlashTmp: true,
          },
        },
      });
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('maps an explicit read-only policy to a network-disabled Codex sandbox', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'nuncio-codex-read-only-'));
    const canonicalRoot = realpathSync(workspaceRoot);
    try {
      const created = sessions.create({
        id: 'session-policy-read-only',
        prompt: 'Review without edits',
        provider: 'codex',
        model: 'codex:gpt-5.5',
        providerThreadId: 'existing-policy-thread',
      });
      await provider.run(created.id, created.prompt, {
        model: created.model,
        cwd: workspaceRoot,
        runtimePolicy: {
          filesystem: 'read-only',
          workspaceRoot,
          network: 'disabled',
        },
      });

      expect(fakeClient.requests).toContainEqual({
        method: 'thread/resume',
        params: {
          threadId: 'existing-policy-thread',
          model: 'gpt-5.5',
          cwd: canonicalRoot,
          runtimeWorkspaceRoots: [canonicalRoot],
          approvalPolicy: 'never',
          sandbox: 'read-only',
        },
      });
      expect(fakeClient.requests).toContainEqual({
        method: 'turn/start',
        params: {
          threadId: 'existing-policy-thread',
          input: [{ type: 'text', text: 'Review without edits', text_elements: [] }],
          model: 'gpt-5.5',
          cwd: canonicalRoot,
          runtimeWorkspaceRoots: [canonicalRoot],
          approvalPolicy: 'never',
          sandboxPolicy: { type: 'readOnly', networkAccess: false },
        },
      });
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('updates the Nuncio title from Codex thread name notifications', async () => {
    fakeClient.autoCompleteTurn = false;
    fakeClient.emitApprovalRequests = false;
    const created = sessions.create({
      id: 'session-codex-title',
      prompt: 'Investigate why the release app is empty',
      provider: 'codex',
      model: 'codex:gpt-5.5',
    });
    const emitted: Array<{ type: string; payload: unknown }> = [];

    const run = provider.run(created.id, created.prompt, {
      emit: (event) => emitted.push(event),
      cwd: '/tmp/project',
      model: created.model,
    });

    await waitUntil(() => sessions.findById(created.id)?.providerActiveTurnId === 'turn-1');
    fakeClient.emitNotification({
      method: 'thread/name/updated',
      params: { threadId: 'codex-thread-1', threadName: 'Diagnose empty release app' },
    });
    fakeClient.completeTurn();
    await run;

    expect(sessions.findById(created.id)?.title).toBe('Diagnose empty release app');
    expect(events.list(created.id)).toContainEqual(
      expect.objectContaining({
        type: 'session_title',
        payload: { title: 'Diagnose empty release app' },
      }),
    );
    expect(emitted).toContainEqual(
      expect.objectContaining({
        type: 'session_title',
        payload: { title: 'Diagnose empty release app' },
      }),
    );
  });

  it('fans out a Codex title notification that arrives just after turn completion', async () => {
    const created = sessions.create({
      id: 'session-codex-late-title',
      prompt: 'Finish before naming this thread',
      provider: 'codex',
      model: 'codex:gpt-5.5',
    });
    const emitted: Array<{ type: string; payload: unknown }> = [];

    await provider.run(created.id, created.prompt, {
      emit: (event) => emitted.push(event),
      cwd: '/tmp/project',
      model: created.model,
    });
    fakeClient.emitNotification({
      method: 'thread/name/updated',
      params: { threadId: 'codex-thread-1', threadName: 'Late but valid title' },
    });

    expect(sessions.findById(created.id)?.title).toBe('Late but valid title');
    expect(emitted).toContainEqual(
      expect.objectContaining({
        type: 'session_title',
        payload: { title: 'Late but valid title' },
      }),
    );
  });

  it('flushes slow Codex deltas while the turn is still running', async () => {
    fakeClient.autoCompleteTurn = false;
    fakeClient.emitApprovalRequests = false;
    const created = sessions.create({
      id: 'session-slow-stream',
      prompt: 'Stream slowly',
      provider: 'codex',
      model: 'codex:gpt-5.5',
    });
    const emitted: Array<{ type: string; payload: unknown }> = [];

    const run = provider.run(created.id, created.prompt, {
      emit: (event) => emitted.push(event),
      cwd: '/tmp/project',
      model: created.model,
    });

    await waitUntil(() => sessions.findById(created.id)?.providerActiveTurnId === 'turn-1');
    await waitUntil(() => emitted.some((event) => event.type === 'assistant_delta'));
    expect(await settledWithin(run, 10)).toBe('timeout');
    expect(events.list(created.id).filter((event) => event.type === 'assistant_delta')).toEqual([
      expect.objectContaining({ payload: { delta: 'Hello' } }),
    ]);

    fakeClient.emitNotification({
      method: 'item/agentMessage/delta',
      params: { threadId: 'codex-thread-1', turnId: 'turn-1', delta: ' world' },
    });
    fakeClient.completeTurn();
    await run;

    const all = events.list(created.id);
    expect(all.filter((event) => event.type === 'assistant_delta')).toEqual([
      expect.objectContaining({ payload: { delta: 'Hello' } }),
      expect.objectContaining({ payload: { delta: ' world' } }),
    ]);
    expect(all.at(-2)).toMatchObject({
      type: 'assistant_message',
      payload: { text: 'Hello world' },
    });
    expect(all.at(-1)).toMatchObject({ type: 'status', payload: { status: 'IDLE' } });
  });

  it('separates consecutive Codex agentMessage items with a paragraph break', async () => {
    fakeClient.autoCompleteTurn = false;
    fakeClient.emitApprovalRequests = false;
    fakeClient.suppressAutoDelta = true;
    const created = sessions.create({
      id: 'session-multi-item',
      prompt: 'Plan the work',
      provider: 'codex',
      model: 'codex:gpt-5.5',
    });
    const emitted: Array<{ type: string; payload: unknown }> = [];

    const run = provider.run(created.id, created.prompt, {
      emit: (event) => emitted.push(event),
      cwd: '/tmp/project',
      model: created.model,
    });

    await waitUntil(() => sessions.findById(created.id)?.providerActiveTurnId === 'turn-1');

    // Two deltas share one item; the third begins a new item. Codex emits no
    // separator between items, so the provider must break at the item boundary.
    for (const [itemId, delta] of [
      ['msg-a', 'First section.'],
      ['msg-a', ' Same section.'],
      ['msg-b', 'Second section.'],
    ] as const) {
      fakeClient.emitNotification({
        method: 'item/agentMessage/delta',
        params: { threadId: 'codex-thread-1', turnId: 'turn-1', itemId, delta },
      });
    }
    fakeClient.completeTurn();
    await run;

    const all = events.list(created.id);
    const message = all.find((event) => event.type === 'assistant_message');
    expect(message?.payload).toEqual({
      text: 'First section. Same section.\n\nSecond section.',
    });

    // The boundary is streamed live too: the joined delta stream (which the web
    // client concatenates) carries the break, independent of delta coalescing.
    const streamed = all
      .filter((event) => event.type === 'assistant_delta')
      .map((event) => (event.payload as { delta: string }).delta)
      .join('');
    expect(streamed).toBe('First section. Same section.\n\nSecond section.');
  });

  it('inserts a fresh paragraph break when an earlier item id reappears after a different item', async () => {
    // Out-of-order edge: deltas arrive for item A, then B, then A again. The
    // provider tracks only the *most recent* item id, so the returning A is
    // treated as a brand-new item and gets its own paragraph break. This pins
    // the current behavior: boundaries are drawn wherever the id CHANGES from
    // the previous delta, not by grouping all deltas of one id together. Nothing
    // is dropped and no text runs together — the final message concatenates all
    // three segments with a break at each id change.
    fakeClient.autoCompleteTurn = false;
    fakeClient.emitApprovalRequests = false;
    fakeClient.suppressAutoDelta = true;
    const created = sessions.create({
      id: 'session-reorder-item',
      prompt: 'Interleaved items',
      provider: 'codex',
      model: 'codex:gpt-5.5',
    });
    const emitted: Array<{ type: string; payload: unknown }> = [];

    const run = provider.run(created.id, created.prompt, {
      emit: (event) => emitted.push(event),
      cwd: '/tmp/project',
      model: created.model,
    });

    await waitUntil(() => sessions.findById(created.id)?.providerActiveTurnId === 'turn-1');

    for (const [itemId, delta] of [
      ['msg-a', 'Alpha.'],
      ['msg-b', 'Bravo.'],
      ['msg-a', 'Alpha again.'],
    ] as const) {
      fakeClient.emitNotification({
        method: 'item/agentMessage/delta',
        params: { threadId: 'codex-thread-1', turnId: 'turn-1', itemId, delta },
      });
    }
    fakeClient.completeTurn();
    await run;

    const all = events.list(created.id);
    const message = all.find((event) => event.type === 'assistant_message');
    // A break appears at every id transition (a->b and b->a), so the returning
    // 'msg-a' segment starts its own paragraph rather than joining the first.
    expect(message?.payload).toEqual({
      text: 'Alpha.\n\nBravo.\n\nAlpha again.',
    });

    // No break at the very start or end; the streamed delta join matches the
    // final message exactly, so live and persisted text never diverge.
    const streamed = all
      .filter((event) => event.type === 'assistant_delta')
      .map((event) => (event.payload as { delta: string }).delta)
      .join('');
    expect(streamed).toBe('Alpha.\n\nBravo.\n\nAlpha again.');
    expect(streamed.startsWith('\n')).toBe(false);
    expect(streamed.endsWith('\n')).toBe(false);
  });

  it('lists model-specific GPT-5.6 reasoning efforts and fast priority options', async () => {
    provider.commandRunner = async () => ({
      status: 0,
      stdout: 'ok',
      stderr: '',
    });

    const providers = await provider.listModels();
    const models = providers[0]?.groups?.[0]?.models ?? [];
    const sol = models.find((model) => model.id === 'codex:gpt-5.6-sol');
    const terra = models.find((model) => model.id === 'codex:gpt-5.6-terra');
    const luna = models.find((model) => model.id === 'codex:gpt-5.6-luna');

    expect(models.map((model) => model.id)).toEqual([
      'codex:gpt-5.6-sol',
      'codex:gpt-5.6-terra',
      'codex:gpt-5.6-luna',
    ]);
    expect(sol?.options).toContainEqual({
      id: 'reasoningEffort',
      label: 'Reasoning',
      type: 'select',
      defaultValue: 'low',
      options: [
        { id: 'low', label: 'Low', isDefault: true },
        { id: 'medium', label: 'Medium', isDefault: false },
        { id: 'high', label: 'High', isDefault: false },
        { id: 'xhigh', label: 'Extra High', isDefault: false },
        { id: 'max', label: 'Max', isDefault: false },
        { id: 'ultra', label: 'Ultra · Multi-agent', isDefault: false },
      ],
    });
    const terraReasoning = terra?.options?.find((option) => option.id === 'reasoningEffort');
    expect(terraReasoning?.defaultValue).toBe('medium');
    expect(terraReasoning?.options?.at(-1)).toEqual({
      id: 'ultra',
      label: 'Ultra · Multi-agent',
      isDefault: false,
    });
    expect(luna?.options?.find((option) => option.id === 'reasoningEffort')).toMatchObject({
      defaultValue: 'medium',
      options: [
        { id: 'low', label: 'Low', isDefault: false },
        { id: 'medium', label: 'Medium', isDefault: true },
        { id: 'high', label: 'High', isDefault: false },
        { id: 'xhigh', label: 'Extra High', isDefault: false },
        { id: 'max', label: 'Max', isDefault: false },
      ],
    });
    expect(sol?.options).toContainEqual({
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

  it('forwards GPT-5.6 Ultra through the app-server effort field', async () => {
    const created = sessions.create({
      id: 'session-ultra',
      prompt: 'Delegate independent checks',
      provider: 'codex',
      model: 'codex:gpt-5.6-sol',
      modelOptions: { reasoningEffort: 'ultra' },
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
        input: [{ type: 'text', text: 'Delegate independent checks', text_elements: [] }],
        model: 'gpt-5.6-sol',
        effort: 'ultra',
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

  it('resumes a persisted Codex thread with Nuncio developer instructions and a clean user turn', async () => {
    const created = sessions.create({
      id: 'session-2',
      prompt: 'Initial prompt',
      provider: 'codex',
      model: 'codex:gpt-5.5',
    });
    sessions.updateProviderRuntimeState(created.id, {
      providerThreadId: 'codex-existing-thread',
    });
    const runtimeEnvironment = buildAgentRuntimeEnvironment({
      sessionId: created.id,
      provider: 'codex',
      model: created.model,
      projectPath: '/tmp/project',
      cwd: '/tmp/project',
      supportsInteraction: false,
      runtimeTools: { tools: [] },
    });

    await provider.steer(created.id, 'Continue', {
      model: created.model,
      cwd: '/tmp/project',
      runtimeEnvironment,
    });

    expect(fakeClient.requests).toContainEqual({
      method: 'thread/resume',
      params: {
        threadId: 'codex-existing-thread',
        model: 'gpt-5.5',
        cwd: '/tmp/project',
        approvalPolicy: 'never',
        sandbox: 'danger-full-access',
        developerInstructions: expect.stringContaining('running inside Nuncio'),
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

  it('invalidates a Codex thread after thread/resume fails', async () => {
    const created = sessions.create({
      id: 'session-stale-resume',
      prompt: 'Initial prompt',
      provider: 'codex',
      model: 'codex:gpt-5.5',
      providerThreadId: 'stale-codex-thread',
    });
    fakeClient.threadResumeError = new Error('thread not found');

    await provider.steer(created.id, 'Continue', {
      model: created.model,
      cwd: '/tmp/project',
    });

    const failed = sessions.findById(created.id)!;
    expect(failed.status).toBe('ERROR');
    expect(failed.providerThreadId).toBeNull();
    expect(provider.canResumeThread(failed)).toBe(false);
    expect(fakeClient.requests.filter((request) => request.method === 'thread/start')).toHaveLength(0);
  });

  it('preserves a Codex thread after a transient resume transport failure', async () => {
    const created = sessions.create({
      id: 'session-transient-resume',
      prompt: 'Initial prompt',
      provider: 'codex',
      model: 'codex:gpt-5.5',
      providerThreadId: 'durable-codex-thread',
    });
    fakeClient.threadResumeError = new Error('codex app-server disconnected');

    await provider.steer(created.id, 'Continue', {
      model: created.model,
      cwd: '/tmp/project',
    });

    const failed = sessions.findById(created.id)!;
    expect(failed.status).toBe('ERROR');
    expect(failed.providerThreadId).toBe('durable-codex-thread');
    expect(provider.canResumeThread(failed)).toBe(true);
  });

  it('does not treat an authentication error mentioning a thread as stale continuity', async () => {
    const created = sessions.create({
      id: 'session-auth-resume',
      prompt: 'Initial prompt',
      provider: 'codex',
      model: 'codex:gpt-5.5',
      providerThreadId: 'auth-retry-thread',
    });
    fakeClient.threadResumeError = new Error('invalid credentials while resuming thread');

    await provider.steer(created.id, 'Continue', {
      model: created.model,
      cwd: '/tmp/project',
    });

    expect(sessions.findById(created.id)).toMatchObject({
      status: 'ERROR',
      providerThreadId: 'auth-retry-thread',
    });
  });

  it('updates the Nuncio title from the resumed Codex thread name', async () => {
    fakeClient.threadResumeName = 'Continue Codex title sync';
    const created = sessions.create({
      id: 'session-resume-title',
      prompt: 'Initial prompt with a verbose first-message title',
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

    expect(sessions.findById(created.id)?.title).toBe('Continue Codex title sync');
    expect(events.list(created.id)).toContainEqual(
      expect.objectContaining({
        type: 'session_title',
        payload: { title: 'Continue Codex title sync' },
      }),
    );
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

  it('registers compatible Codex tools, sends Nuncio developer instructions, and keeps user text clean', async () => {
    fakeClient.autoCompleteTurn = false;
    fakeClient.emitApprovalRequests = false;
    fakeClient.suppressAutoDelta = true;
    const created = sessions.create({
      id: 'session-dynamic-tools',
      prompt: 'use browser',
      provider: 'codex',
      model: 'codex:gpt-5.5',
    });
    const tools = {
      systemPromptAppend: 'Use Nuncio tools deliberately.',
      tools: [
        {
          name: 'nuncio_runtime_info',
          description: 'Read Nuncio runtime information.',
          inputSchema: { type: 'object', properties: {} },
          execute: async () => 'runtime',
        },
        {
          name: 'nuncio_echo',
          description: 'Echo a message through Nuncio runtime tools.',
          inputSchema: {
            type: 'object',
            properties: { message: { type: 'string' } },
            required: ['message'],
          },
          execute: async (input: Record<string, unknown>) => `echo ${String(input.message)}`,
        },
      ],
    };
    const runtimeEnvironment = buildAgentRuntimeEnvironment({
      sessionId: created.id,
      provider: 'codex',
      model: created.model,
      projectPath: '/tmp/project',
      cwd: '/tmp/project',
      supportsInteraction: false,
      runtimeTools: tools,
    });

    const run = provider.run(created.id, created.prompt, {
      model: created.model,
      cwd: '/tmp/project',
      tools,
      runtimeEnvironment,
    });

    await waitUntil(() => sessions.findById(created.id)?.providerActiveTurnId === 'turn-1');
    const threadStart = fakeClient.requests.find((request) => request.method === 'thread/start');
    const instructions = String(
      (threadStart?.params as Record<string, unknown>).developerInstructions ?? '',
    );
    expect(instructions).toContain('running inside Nuncio');
    expect(instructions).toContain('available tools: nuncio_echo');
    expect(instructions).toContain('When available, call nuncio_runtime_info');
    expect(threadStart?.params).toMatchObject({
      dynamicTools: [
        {
          type: 'function',
          name: 'nuncio_echo',
          description: 'Echo a message through Nuncio runtime tools.',
          inputSchema: {
            type: 'object',
            properties: { message: { type: 'string' } },
            required: ['message'],
          },
        },
      ],
    });
    const turnStart = fakeClient.requests.find((request) => request.method === 'turn/start');
    expect((turnStart?.params as { input: unknown }).input).toEqual([
      { type: 'text', text: 'use browser', text_elements: [] },
    ]);

    fakeClient.emitServerRequest({
      id: 'tool-call-1',
      method: 'item/tool/call',
      params: {
        threadId: 'codex-thread-1',
        turnId: 'turn-1',
        callId: 'call-1',
        namespace: null,
        tool: 'nuncio_echo',
        arguments: { message: 'hello' },
      },
    });

    await waitUntil(() => fakeClient.responses.length === 1);
    expect(fakeClient.responses[0]).toEqual({
      id: 'tool-call-1',
      result: {
        contentItems: [{ type: 'inputText', text: 'echo hello' }],
        success: true,
      },
    });

    fakeClient.completeTurn();
    await run;
  });

  it('resumes one Codex thread with a stable trusted tool surface and refreshed authority closures', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'nuncio-codex-tool-resume-'));
    const runtimePolicy = {
      filesystem: 'read-only' as const,
      workspaceRoot,
      network: 'disabled' as const,
    };
    try {
      fakeClient.emitApprovalRequests = false;
      fakeClient.suppressAutoDelta = true;
      const created = sessions.create({
        id: 'session-stable-trusted-tools',
        prompt: 'Plan revision one',
        provider: 'codex',
        model: 'codex:gpt-5.5',
      });

      await provider.run(created.id, created.prompt, {
        model: created.model,
        cwd: workspaceRoot,
        runtimePolicy,
        tools: stableTrustedTools(1),
      });

      const firstThreadStart = fakeClient.requests.find((request) => request.method === 'thread/start');
      expect(firstThreadStart?.params).toMatchObject({
        allowProviderModelFallback: false,
        dynamicTools: [
          { name: 'submit_plan' },
          { name: 'submit_synthesis' },
        ],
      });
      expect(sessions.findById(created.id)?.providerState).toMatchObject({
        codexDynamicToolSurface: expect.any(String),
      });

      provider.dispose(created.id);
      const resumedClient = new FakeCodexClient();
      resumedClient.autoCompleteTurn = false;
      resumedClient.emitApprovalRequests = false;
      resumedClient.suppressAutoDelta = true;
      provider.clientFactory = () => resumedClient;

      const resumed = provider.steer(created.id, 'Synthesize revision two', {
        model: created.model,
        cwd: workspaceRoot,
        runtimePolicy,
        tools: stableTrustedTools(2),
      });
      await waitUntil(() => sessions.findById(created.id)?.providerActiveTurnId === 'turn-1');

      const resumeRequest = resumedClient.requests.find((request) => request.method === 'thread/resume');
      expect(resumeRequest?.params).not.toHaveProperty('dynamicTools');
      resumedClient.emitServerRequest({
        id: 'tool-revision-2',
        method: 'item/tool/call',
        params: { tool: 'submit_synthesis', arguments: {} },
      });
      await waitUntil(() => resumedClient.responses.length === 1);
      expect(resumedClient.responses[0]).toEqual({
        id: 'tool-revision-2',
        result: {
          contentItems: [{ type: 'inputText', text: 'submit_synthesis revision 2' }],
          success: true,
        },
      });

      resumedClient.completeTurn();
      await resumed;
      expect(sessions.findById(created.id)?.providerThreadId).toBe('codex-thread-1');
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
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

  it('awaits Codex turn/interrupt acknowledgement before settling and closing the active turn', async () => {
    fakeClient.autoCompleteTurn = false;
    fakeClient.delayInterruptAcknowledgement();
    const created = sessions.create({
      id: 'session-awaited-interrupt',
      prompt: 'Keep writing until interruption is acknowledged',
      provider: 'codex',
      model: 'codex:gpt-5.5',
    });
    const run = provider.run(created.id, created.prompt, {
      model: created.model,
      cwd: '/tmp/project',
    });
    await waitUntil(() => sessions.findById(created.id)?.providerActiveTurnId === 'turn-1');

    let settled = false;
    const interrupting = provider.interrupt(created.id).then(() => {
      settled = true;
    });
    await Promise.resolve();

    expect(settled).toBe(false);
    expect(fakeClient.closed).toBe(false);

    fakeClient.releaseInterruptAcknowledgement();
    await interrupting;

    expect(fakeClient.requests.at(-1)).toMatchObject({
      method: 'turn/interrupt',
      params: { threadId: 'codex-thread-1', turnId: 'turn-1' },
    });
    expect(fakeClient.closed).toBe(true);
    await expect(settledWithin(run)).resolves.toBe('settled');
    expect(sessions.findById(created.id)?.status).toBe('IDLE');
  });

  it('flushes buffered deltas before closing active Codex sessions on module destroy', async () => {
    fakeClient.autoCompleteTurn = false;
    fakeClient.emitApprovalRequests = false;
    const created = sessions.create({
      id: 'session-destroy-flush',
      prompt: 'Stream before shutdown',
      provider: 'codex',
      model: 'codex:gpt-5.5',
    });

    const run = provider.run(created.id, created.prompt, {
      model: created.model,
      cwd: '/tmp/project',
    });

    await waitUntil(() => sessions.findById(created.id)?.preview === 'Hello');
    fakeClient.emitNotification({
      method: 'item/agentMessage/delta',
      params: { threadId: 'codex-thread-1', turnId: 'turn-1', delta: ' tail' },
    });
    expect(events.list(created.id).filter((event) => event.type === 'assistant_delta')).toEqual([
      expect.objectContaining({ payload: { delta: 'Hello' } }),
    ]);

    destroyProvider(provider);

    expect(fakeClient.closed).toBe(true);
    expect(events.list(created.id).filter((event) => event.type === 'assistant_delta')).toEqual([
      expect.objectContaining({ payload: { delta: 'Hello' } }),
      expect.objectContaining({ payload: { delta: ' tail' } }),
    ]);
    await expect(settledWithin(run)).resolves.toBe('settled');
  });

  it('closes every reusable Codex app-server client on module destroy', async () => {
    const clients: FakeCodexClient[] = [];
    provider.clientFactory = () => {
      const client = new FakeCodexClient();
      client.emitApprovalRequests = false;
      clients.push(client);
      return client;
    };
    const first = sessions.create({
      id: 'session-destroy-one',
      prompt: 'First',
      provider: 'codex',
      model: 'codex:gpt-5.5',
    });
    const second = sessions.create({
      id: 'session-destroy-two',
      prompt: 'Second',
      provider: 'codex',
      model: 'codex:gpt-5.5',
    });

    await provider.run(first.id, first.prompt, { model: first.model, cwd: '/tmp/project' });
    await provider.run(second.id, second.prompt, { model: second.model, cwd: '/tmp/project' });

    expect(clients).toHaveLength(2);
    destroyProvider(provider);

    expect(clients.every((client) => client.closed)).toBe(true);
  });

  it('uses DB-backed Codex binary and home settings for daemon probes and clients', async () => {
    const settings = module.get(SettingsService);
    settings.set('NUNCIO_CODEX_BIN', '/opt/nuncio/bin/codex');
    settings.set('NUNCIO_CODEX_HOME', '/tmp/nuncio-codex-home');
    const probes: Array<{ command: string; args: string[]; codexHome?: string }> = [];
    provider.commandRunner = async (command, args, options) => {
      probes.push({ command, args, codexHome: options.env.CODEX_HOME });
      return { status: 0, stdout: 'Logged in using ChatGPT', stderr: '' };
    };

    expect(await provider.isAvailable()).toBe(true);
    expect(probes).toEqual([
      { command: '/opt/nuncio/bin/codex', args: ['--version'], codexHome: '/tmp/nuncio-codex-home' },
      { command: '/opt/nuncio/bin/codex', args: ['login', 'status'], codexHome: '/tmp/nuncio-codex-home' },
    ]);

    let clientInput: Parameters<NonNullable<CodexAgentProvider['clientFactory']>>[0] | undefined;
    provider.clientFactory = (input) => {
      clientInput = input;
      return fakeClient;
    };
    const created = sessions.create({
      id: 'session-daemon-config',
      prompt: 'Use configured daemon',
      provider: 'codex',
      model: 'codex:gpt-5.5',
    });

    await provider.run(created.id, created.prompt, {
      model: created.model,
      cwd: '/tmp/project',
    });

    expect(clientInput).toMatchObject({
      binaryPath: '/opt/nuncio/bin/codex',
      cwd: '/tmp/project',
    });
    expect(clientInput?.env.CODEX_HOME).toBe('/tmp/nuncio-codex-home');
  });

  it('auto-discovers one logged-in Codex CLI candidate for daemon clients', async () => {
    const settings = module.get(SettingsService);
    settings.clear('NUNCIO_CODEX_BIN');
    provider.cliCandidatePaths = ['/opt/nuncio/current/bin/codex'];
    const probes: Array<{ command: string; args: string[] }> = [];
    provider.commandRunner = async (command, args) => {
      probes.push({ command, args });
      return { status: 0, stdout: 'codex-cli 0.142.5', stderr: '' };
    };

    expect(await provider.isAvailable()).toBe(true);
    expect(probes).toEqual([
      { command: '/opt/nuncio/current/bin/codex', args: ['--version'] },
      { command: '/opt/nuncio/current/bin/codex', args: ['login', 'status'] },
    ]);

    let clientInput: Parameters<NonNullable<CodexAgentProvider['clientFactory']>>[0] | undefined;
    provider.clientFactory = (input) => {
      clientInput = input;
      return fakeClient;
    };
    const created = sessions.create({
      id: 'session-auto-discovered-cli',
      prompt: 'Use auto-discovered daemon',
      provider: 'codex',
      model: 'codex:gpt-5.5',
    });

    await provider.run(created.id, created.prompt, {
      model: created.model,
      cwd: '/tmp/project',
    });

    expect(clientInput).toMatchObject({
      binaryPath: '/opt/nuncio/current/bin/codex',
      cwd: '/tmp/project',
    });
  });

  it('does not report Codex available when multiple logged-in CLIs need selection', async () => {
    settingsClear(module.get(SettingsService), 'NUNCIO_CODEX_BIN');
    provider.cliCandidatePaths = ['/opt/codex-stable/bin/codex', '/opt/codex-nightly/bin/codex'];
    provider.commandRunner = async () => ({ status: 0, stdout: 'codex-cli 0.142.5', stderr: '' });

    expect(await provider.isAvailable()).toBe(false);
  });

  it('uses approval-required runtime settings for Codex daemon thread and turn startup', async () => {
    const settings = module.get(SettingsService);
    settings.set('NUNCIO_CODEX_RUNTIME_MODE', 'approval-required');
    fakeClient.emitApprovalRequests = false;
    const created = sessions.create({
      id: 'session-approval-runtime-mode',
      prompt: 'Use approvals',
      provider: 'codex',
      model: 'codex:gpt-5.5',
    });

    await provider.run(created.id, created.prompt, {
      model: created.model,
      cwd: '/tmp/project',
    });

    expect(fakeClient.requests).toContainEqual({
      method: 'thread/start',
      params: {
        model: 'gpt-5.5',
        cwd: '/tmp/project',
        approvalPolicy: 'untrusted',
        sandbox: 'read-only',
        experimentalRawEvents: false,
      },
    });
    expect(fakeClient.requests).toContainEqual({
      method: 'turn/start',
      params: {
        threadId: 'codex-thread-1',
        input: [{ type: 'text', text: 'Use approvals', text_elements: [] }],
        model: 'gpt-5.5',
        approvalPolicy: 'untrusted',
        sandboxPolicy: { type: 'readOnly' },
      },
    });
  });

  it('forwards codexMcpConfig on thread/start to suppress inherited MCP servers', async () => {
    const created = sessions.create({
      prompt: 'Suppress inherited MCP',
      provider: 'codex',
      model: 'codex:gpt-5.5',
    });

    await provider.run(created.id, created.prompt, {
      model: created.model,
      cwd: '/tmp/project',
      codexMcpConfig: {
        mcp_servers: {
          playwright: { enabled: false },
        },
      },
    });

    expect(fakeClient.requests).toContainEqual({
      method: 'thread/start',
      params: expect.objectContaining({
        config: {
          mcp_servers: {
            playwright: { enabled: false },
          },
        },
      }),
    });
  });

  it('reports availability from codex login status', async () => {
    const settings = module.get(SettingsService);
    settings.resolve = ((key: string) => {
      if (key === 'NUNCIO_CODEX_BIN') return 'codex';
      return undefined;
    }) as SettingsService['resolve'];
    provider.cliCandidatePaths = ['/opt/nuncio/bin/codex'];
    provider.commandRunner = async (_command, args) => ({
      status: args[0] === 'login' ? 0 : 0,
      stdout: 'Logged in using ChatGPT',
      stderr: '',
    });

    expect(await provider.isAvailable()).toBe(true);
  });
});

function settingsClear(settings: SettingsService, key: string): void {
  try {
    settings.clear(key);
  } catch {
    // Test helper for mocked/overridden settings objects.
  }
}

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

function stableTrustedTools(revision: number) {
  const submissionSchema = {
    type: 'object',
    properties: {
      runId: { type: 'string' },
      contextRevision: { type: 'integer' },
      result: { type: 'object' },
    },
    required: ['runId', 'contextRevision', 'result'],
  };
  const security = {
    network: 'disabled' as const,
    workspaceMutation: 'none' as const,
    runtimePolicies: [{ filesystem: 'read-only' as const, network: 'disabled' as const }],
    scope: 'policy-internal' as const,
  };
  return {
    systemPromptAppend: `Use authority for context revision ${revision}.`,
    tools: ['plan', 'synthesis'].map((kind) => defineTrustedRuntimeTool({
      name: `submit_${kind}`,
      inputSchema: submissionSchema,
      security,
      execute: async () => `submit_${kind} revision ${revision}`,
    })),
  };
}

function destroyProvider(provider: CodexAgentProvider): void {
  const destroyable = provider as CodexAgentProvider & { onModuleDestroy?: () => void };
  expect(typeof destroyable.onModuleDestroy).toBe('function');
  destroyable.onModuleDestroy!();
}
