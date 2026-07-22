import { AgentRunCancelledError } from '../../../src/agents/agents.base-provider';
import type { AgentRunContext } from '../../../src/agents/agents.types';
import {
  DevinAcpRequestError,
  type DevinAcpClientLike,
  type DevinAcpError,
} from '../../../src/agents/providers/devin-acp.client';
import { DevinAgentProvider } from '../../../src/agents/providers/devin-agent.provider';

class TestProvider extends DevinAgentProvider {
  execute(id: string, context: AgentRunContext): Promise<void> {
    return this.executePrompt(id, 'lifecycle', false, context);
  }
}

class FakeClient implements DevinAcpClientLike {
  readonly calls: Array<{ method: string; params: unknown; timeoutMs?: number | null }> = [];
  closeCount = 0;
  initializeHandler?: () => Promise<void>;
  requestHandler?: (method: string, params: unknown) => unknown;
  serverSubscriptionError?: Error;
  private notifications = new Set<(value: { method: string; params?: unknown }) => void>();
  private requests = new Set<(value: { id: string | number; method: string; params?: unknown }) => void>();
  private closes = new Set<(error: Error) => void>();

  async initialize(): Promise<void> { await this.initializeHandler?.(); }
  async request<T>(method: string, params: unknown, timeoutMs?: number | null): Promise<T> {
    this.calls.push({ method, params, ...(timeoutMs !== undefined ? { timeoutMs } : {}) });
    return (await this.requestHandler?.(method, params) ?? {}) as T;
  }
  onNotification(listener: (value: { method: string; params?: unknown }) => void): () => void {
    this.notifications.add(listener);
    return () => this.notifications.delete(listener);
  }
  onServerRequest(listener: (value: { id: string | number; method: string; params?: unknown }) => void): () => void {
    if (this.serverSubscriptionError) throw this.serverSubscriptionError;
    this.requests.add(listener);
    return () => this.requests.delete(listener);
  }
  onClose(listener: (error: Error) => void): () => void {
    this.closes.add(listener);
    return () => this.closes.delete(listener);
  }
  respond(): void {}
  respondError(_id: string | number, _error: DevinAcpError): void {}
  close(): void { this.closeCount += 1; }
  stop(): void {
    for (const listener of this.notifications) {
      listener({ method: '_cognition.ai/agent_stopped', params: {} });
    }
  }
  fail(error: Error): void { for (const listener of this.closes) listener(error); }
  listenerCount(): number { return this.notifications.size + this.requests.size + this.closes.size; }
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > 1_000) throw new Error('waitUntil timed out');
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
} {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function setup(providerThreadId: string | null = null) {
  const emitted: Array<{ type: string; payload: unknown }> = [];
  const state = {
    providerThreadId,
    providerState: null as Record<string, unknown> | null,
    status: 'IDLE',
  };
  const sessions = {
    findById: () => state,
    updateStatus: (_id: string, status: string) => { state.status = status; return state; },
    updateProviderRuntimeState: (_id: string, update: { providerThreadId?: string | null; providerState?: Record<string, unknown> | null }) => {
      if (update.providerThreadId !== undefined) state.providerThreadId = update.providerThreadId;
      if (update.providerState !== undefined) state.providerState = update.providerState;
      return state;
    },
  };
  let seq = 0;
  const events = {
    append: (_id: string, type: string, payload: unknown) => ({ seq: ++seq, type, payload }),
    transaction: <T>(run: () => T) => run(),
    notifyPersisted: () => undefined,
  };
  const provider = new TestProvider(sessions as never, events as never, { resolve: () => undefined } as never);
  const client = new FakeClient();
  provider.clientFactory = () => client;
  return { provider, client, state, emitted };
}

function staleSessionError(): DevinAcpRequestError {
  return new DevinAcpRequestError('session/load', { code: -32602, message: 'Session not found' });
}

describe('DevinAgentProvider lifecycle hardening', () => {
  it('invalidates a stale resume id and falls back to a fresh ACP session', async () => {
    const { provider, client, state } = setup('stale-id');
    client.requestHandler = (method) => {
      if (method === 'session/load') throw staleSessionError();
      if (method === 'session/new') return { sessionId: 'fresh-id' };
      if (method === 'session/prompt') queueMicrotask(() => client.stop());
      return {};
    };

    await expect(provider.execute('s1', { cwd: '/tmp' })).resolves.toBeUndefined();

    expect(client.calls.map((call) => call.method)).toContain('session/load');
    expect(client.calls.map((call) => call.method)).toContain('session/new');
    expect(state.providerThreadId).toBe('fresh-id');
    expect(client.closeCount).toBe(0);
  });

  it('keeps a stale id invalidated and closes when fresh-session fallback fails', async () => {
    const { provider, client, state } = setup('stale-id');
    client.requestHandler = (method) => {
      if (method === 'session/load') throw staleSessionError();
      if (method === 'session/new') throw new Error('fresh session failed');
      return {};
    };

    await expect(provider.execute('s1', { cwd: '/tmp' })).rejects.toThrow('fresh session failed');
    expect(state.providerThreadId).toBeNull();
    expect(client.closeCount).toBe(1);
    expect(client.listenerCount()).toBe(0);
  });

  it('does not fork on a non-stale load error and still closes failed setup', async () => {
    const { provider, client, state } = setup('existing-id');
    client.requestHandler = (method) => {
      if (method === 'session/load') {
        throw new DevinAcpRequestError(method, { code: -32603, message: 'backend unavailable' });
      }
      return {};
    };

    await expect(provider.execute('s1', { cwd: '/tmp' })).rejects.toThrow('backend unavailable');
    expect(client.calls.map((call) => call.method)).not.toContain('session/new');
    expect(state.providerThreadId).toBe('existing-id');
    expect(client.closeCount).toBe(1);
    expect(client.listenerCount()).toBe(0);
  });

  it('closes and removes earlier listeners when callback registration fails', async () => {
    const { provider, client } = setup();
    client.serverSubscriptionError = new Error('listener registration failed');

    await expect(provider.execute('s1', { cwd: '/tmp' })).rejects.toThrow('listener registration failed');
    expect(client.closeCount).toBe(1);
    expect(client.listenerCount()).toBe(0);
  });

  it('closes and unsubscribes when initialization fails before session setup', async () => {
    const { provider, client } = setup();
    client.initializeHandler = async () => { throw new Error('initialize failed'); };

    await expect(provider.execute('s1', { cwd: '/tmp' })).rejects.toThrow('initialize failed');
    expect(client.closeCount).toBe(1);
    expect(client.listenerCount()).toBe(0);
  });

  it('closes and unsubscribes when session configuration fails after creation', async () => {
    const { provider, client } = setup();
    client.requestHandler = (method) => {
      if (method === 'session/new') return { sessionId: 'created-id' };
      if (method === 'session/set_config_option') throw new Error('config failed');
      return {};
    };

    await expect(provider.execute('s1', { cwd: '/tmp' })).rejects.toThrow('config failed');
    expect(client.closeCount).toBe(1);
    expect(client.listenerCount()).toBe(0);
  });

  it('treats an acknowledged cancel plus prompt rejection as interrupted IDLE, not ERROR', async () => {
    const { provider, client, state, emitted } = setup();
    let rejectPrompt: (error: Error) => void = () => undefined;
    client.requestHandler = (method) => {
      if (method === 'session/new') return { sessionId: 'live-id' };
      if (method === 'session/prompt') {
        return new Promise((_resolve, reject) => { rejectPrompt = reject; });
      }
      if (method === 'session/cancel') {
        rejectPrompt(new Error('Request cancelled'));
        return {};
      }
      return {};
    };
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      const run = provider.run('s1', 'interrupt me', { cwd: '/tmp', emit: (event) => emitted.push(event) });
      await waitUntil(() => client.calls.some((call) => call.method === 'session/prompt'));
      await provider.interrupt('s1');
      await run;
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(state.status).toBe('IDLE');
      expect(emitted.some((event) => event.type === 'error')).toBe(false);
      expect(emitted.some((event) => event.type === 'status' && (event.payload as { status?: string }).status === 'ERROR')).toBe(false);
      expect(unhandled).toEqual([]);
      expect(client.closeCount).toBe(1);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('waits for a failed cancel after prompt cancellation before settling the run', async () => {
    const { provider, client, state, emitted } = setup();
    const firstPrompt = deferred();
    const secondPrompt = deferred();
    const cancel = deferred();
    let promptCount = 0;
    client.requestHandler = (method) => {
      if (method === 'session/new') return { sessionId: 'live-id' };
      if (method === 'session/prompt') {
        promptCount += 1;
        return promptCount === 1 ? firstPrompt.promise : secondPrompt.promise;
      }
      if (method === 'session/cancel') return cancel.promise;
      return {};
    };

    let runSettled = false;
    const run = provider.run('s1', 'interrupt me', {
      cwd: '/tmp',
      emit: (event) => emitted.push(event),
    }).then(() => { runSettled = true; });
    await waitUntil(() => promptCount === 1);
    const interruptResult = provider.interrupt('s1').then(
      () => undefined,
      (error: unknown) => error,
    );
    await waitUntil(() => client.calls.some((call) => call.method === 'session/cancel'));

    firstPrompt.reject(new Error('Request cancelled'));
    await new Promise<void>((resolve) => setImmediate(resolve));
    const settledBeforeCancelFailure = runSettled;

    cancel.reject(new Error('cancel transport failed'));
    expect(await interruptResult).toEqual(new Error('cancel transport failed'));
    await run;

    const firstTerminalEvents = emitted.filter(
      (event) => event.type === 'status' &&
        ['IDLE', 'ERROR'].includes((event.payload as { status?: string }).status ?? ''),
    );
    expect(settledBeforeCancelFailure).toBe(false);
    expect(firstTerminalEvents).toHaveLength(1);
    expect(firstTerminalEvents[0]?.payload).toEqual({ status: 'ERROR' });
    expect(state.status).toBe('ERROR');
    expect(client.closeCount).toBe(0);

    const followUp = provider.run('s1', 'try again', {
      cwd: '/tmp',
      emit: (event) => emitted.push(event),
    });
    await waitUntil(() => promptCount === 2);
    secondPrompt.resolve();
    client.stop();
    await followUp;

    expect(state.status).toBe('IDLE');
    expect(emitted.filter(
      (event) => event.type === 'status' &&
        ['IDLE', 'ERROR'].includes((event.payload as { status?: string }).status ?? ''),
    )).toHaveLength(2);
    expect(client.closeCount).toBe(0);

    provider.dispose('s1');
    expect(client.closeCount).toBe(1);
  });

  it('fences a late cancel acknowledgement from a naturally settled turn and queued steer', async () => {
    for (let iteration = 0; iteration < 20; iteration += 1) {
      const { provider, client, state, emitted } = setup();
      const prompts: ReturnType<typeof deferred>[] = [];
      const cancelAcknowledgement = deferred();
      client.requestHandler = (method) => {
        if (method === 'session/new') return { sessionId: 'live-id' };
        if (method === 'session/prompt') {
          const prompt = deferred();
          prompts.push(prompt);
          return prompt.promise;
        }
        if (method === 'session/cancel') return cancelAcknowledgement.promise;
        return {};
      };

      const run = provider.run('s1', 'interrupt me', {
        cwd: '/tmp',
        emit: (event) => emitted.push(event),
      });
      await waitUntil(() => prompts.length === 1);
      const interrupting = provider.interrupt('s1');
      await waitUntil(() => client.calls.some((call) => call.method === 'session/cancel'));

      let queuedSteerStarted = false;
      const queuedSteer = run.then(async () => {
        queuedSteerStarted = true;
        await provider.steer('s1', 'queued follow-up', {
          cwd: '/tmp',
          emit: (event) => emitted.push(event),
        });
      });

      prompts[0]!.resolve();
      client.stop();
      await run;
      await waitUntil(() =>
        queuedSteerStarted &&
        state.status === 'RUNNING' &&
        emitted.some((event) => event.type === 'steer_message'),
      );
      await new Promise<void>((resolve) => setImmediate(resolve));

      const promptCountBeforeAcknowledgement = prompts.length;
      const finishedBeforeAcknowledgement = emitted.filter(
        (event) => event.type === 'status' &&
          (event.payload as { status?: string }).status === 'IDLE',
      ).length;

      cancelAcknowledgement.resolve();
      await interrupting;
      await waitUntil(() => prompts.length === 2 || client.closeCount > 0);
      prompts[1]?.resolve();
      client.stop();
      await queuedSteer;

      const closeCountBeforeDispose = client.closeCount;
      const finishedAfterFollowUp = emitted.filter(
        (event) => event.type === 'status' &&
          (event.payload as { status?: string }).status === 'IDLE',
      ).length;
      const assistantMessages = emitted.filter((event) => event.type === 'assistant_message');
      provider.dispose('s1');

      expect(promptCountBeforeAcknowledgement).toBe(1);
      expect(finishedBeforeAcknowledgement).toBe(1);
      expect(closeCountBeforeDispose).toBe(0);
      expect(finishedAfterFollowUp).toBe(2);
      expect(assistantMessages).toHaveLength(1);
      expect(state.status).toBe('IDLE');
      expect(client.closeCount).toBe(1);
      expect(client.listenerCount()).toBe(0);
    }
  });

  it('does not cancel or close the reusable client when no turn is live', async () => {
    const { provider, client, emitted } = setup();
    client.requestHandler = (method) => {
      if (method === 'session/new') return { sessionId: 'live-id' };
      if (method === 'session/prompt') queueMicrotask(() => client.stop());
      return {};
    };

    await provider.run('s1', 'finish normally', {
      cwd: '/tmp',
      emit: (event) => emitted.push(event),
    });
    await provider.interrupt('s1');

    expect(client.calls.filter((call) => call.method === 'session/cancel')).toHaveLength(0);
    expect(emitted.filter(
      (event) => event.type === 'status' &&
        (event.payload as { status?: string }).status === 'IDLE',
    )).toHaveLength(1);
    expect(client.closeCount).toBe(0);

    provider.dispose('s1');
    expect(client.closeCount).toBe(1);
  });

  it('does not fabricate a terminal assistant message when stopped races an interrupt', async () => {
    const { provider, client, emitted } = setup();
    let rejectPrompt: (error: Error) => void = () => undefined;
    client.requestHandler = (method) => {
      if (method === 'session/new') return { sessionId: 'live-id' };
      if (method === 'session/prompt') {
        return new Promise((_resolve, reject) => { rejectPrompt = reject; });
      }
      if (method === 'session/cancel') {
        client.stop();
        rejectPrompt(new Error('Request cancelled'));
        return {};
      }
      return {};
    };

    const run = provider.run('s1', 'interrupt me', { cwd: '/tmp', emit: (event) => emitted.push(event) });
    await waitUntil(() => client.calls.some((call) => call.method === 'session/prompt'));
    await provider.interrupt('s1');
    await run;

    expect(emitted.some((event) => event.type === 'assistant_message')).toBe(false);
  });

  it('does not claim IDLE or close ownership when the cancel RPC itself fails', async () => {
    const { provider, client, state } = setup();
    let rejectPrompt: (error: Error) => void = () => undefined;
    client.requestHandler = (method) => {
      if (method === 'session/new') return { sessionId: 'live-id' };
      if (method === 'session/prompt') {
        return new Promise((_resolve, reject) => { rejectPrompt = reject; });
      }
      if (method === 'session/cancel') throw new Error('cancel refused');
      return {};
    };

    const run = provider.run('s1', 'interrupt me', { cwd: '/tmp' });
    await waitUntil(() => client.calls.some((call) => call.method === 'session/prompt'));
    await expect(provider.interrupt('s1')).rejects.toThrow('cancel refused');
    expect(state.status).toBe('RUNNING');
    expect(client.closeCount).toBe(0);

    rejectPrompt(new AgentRunCancelledError('test cleanup'));
    client.fail(new AgentRunCancelledError('test cleanup'));
    await run;
  });
});
