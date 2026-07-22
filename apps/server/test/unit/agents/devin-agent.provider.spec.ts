import { DevinAgentProvider } from '../../../src/agents/providers/devin-agent.provider';
import type { AgentRunContext } from '../../../src/agents/agents.types';

class TestProvider extends DevinAgentProvider {
  execute(id: string, text: string, steer: boolean, context: AgentRunContext): Promise<void> {
    return this.executePrompt(id, text, steer, context);
  }
}

class FakeClient {
  readonly calls: Array<{ method: string; params: unknown; timeoutMs?: number | null }> = [];
  private notification?: (value: { method: string; params?: unknown }) => void;
  private serverRequest?: (value: { id: string | number; method: string; params?: unknown }) => void;
  private closeHandler?: (error: Error) => void;
  requestHandler?: (method: string, params: unknown) => unknown;
  initialize = async () => undefined;
  request = async <T>(method: string, params: unknown, timeoutMs?: number | null): Promise<T> => {
    this.calls.push({ method, params, ...(timeoutMs !== undefined ? { timeoutMs } : {}) });
    return (await this.requestHandler?.(method, params) ?? {}) as T;
  };
  onNotification(listener: (value: { method: string; params?: unknown }) => void): () => void {
    this.notification = listener;
    return () => { if (this.notification === listener) this.notification = undefined; };
  }
  onServerRequest(listener: (value: { id: string | number; method: string; params?: unknown }) => void): () => void {
    this.serverRequest = listener;
    return () => { if (this.serverRequest === listener) this.serverRequest = undefined; };
  }
  onClose(listener: (error: Error) => void): () => void {
    this.closeHandler = listener;
    return () => { if (this.closeHandler === listener) this.closeHandler = undefined; };
  }
  readonly responses: Array<{ id: string | number; result?: unknown; error?: { code: number; message: string } }> = [];
  respond(id: string | number, result: unknown): void {
    this.responses.push({ id, result });
  }
  respondError(id: string | number, error: { code: number; message: string }): void {
    this.responses.push({ id, error });
  }
  close(): void {}
  emit(value: { method: string; params?: unknown }): void { this.notification?.(value); }
  emitRequest(value: { id: string | number; method: string; params?: unknown }): void { this.serverRequest?.(value); }
  emitClose(error: Error): void { this.closeHandler?.(error); }
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitUntil timed out');
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe('DevinAgentProvider', () => {
  function setup(
    providerThreadId: string | null = null,
    settingValues: Record<string, string | undefined> = {},
  ) {
    const events: Array<{ type: string; payload: unknown }> = [];
    const state = { providerThreadId, providerState: null as Record<string, unknown> | null, status: 'IDLE' };
    const sessions = {
      findById: () => state,
      updateStatus: (_id: string, status: string) => { state.status = status; return state; },
      updateProviderRuntimeState: (_id: string, update: { providerThreadId?: string; providerState?: Record<string, unknown> }) => {
        if (update.providerThreadId) state.providerThreadId = update.providerThreadId;
        if (update.providerState) state.providerState = update.providerState;
        return state;
      },
    };
    const eventsRepo = { append: (_id: string, type: string, payload: unknown) => ({ seq: 1, type, payload }), appendMany: () => [] };
    const settings = {
      resolve: (key: string) => settingValues[key],
    };
    const provider = new TestProvider(sessions as never, eventsRepo as never, settings as never);
    const client = new FakeClient();
    client.requestHandler = (method) => method === 'session/load' ? { sessionId: providerThreadId } : { sessionId: 'new-session' };
    provider.clientFactory = () => client;
    return { provider, client, state, events };
  }

  it('opens a new session, selects the model, persists its id, and maps updates', async () => {
    const { provider, client, state, events } = setup();
    const run = provider.execute('s1', 'hello', false, { cwd: '/tmp', model: 'devin:swe-1-7-medium', emit: (event) => events.push(event) });
    while (!client.calls.some((call) => call.method === 'session/prompt')) await new Promise((resolve) => setTimeout(resolve, 0));
    client.emit({ method: 'session/update', params: { update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking' } } } });
    client.emit({ method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'answer' } } } });
    client.emit({ method: '_cognition.ai/agent_stopped', params: {} });
    await run;
    expect(client.calls.map((call) => call.method)).toEqual([
      'session/new',
      'session/set_config_option',
      'session/set_config_option',
      'session/prompt',
    ]);
    expect(client.calls.filter((call) => call.method === 'session/set_config_option').map((call) => call.params)).toEqual([
      { sessionId: 'new-session', configId: 'mode', value: 'bypass' },
      { sessionId: 'new-session', configId: 'model', value: 'swe-1-7-medium' },
    ]);
    expect(state.providerThreadId).toBe('new-session');
    expect(events.map((event) => event.type)).toEqual(['thinking_delta', 'assistant_delta', 'assistant_message']);
  });

  it('loads a persisted session and applies the configured permission mode', async () => {
    const { provider, client } = setup('existing', {
      NUNCIO_DEVIN_PERMISSION_MODE: 'plan',
    });
    const run = provider.execute('s1', 'hello', false, { cwd: '/tmp', emit: () => undefined });
    while (!client.calls.some((call) => call.method === 'session/prompt')) await new Promise((resolve) => setTimeout(resolve, 0));
    client.emit({ method: '_cognition.ai/agent_stopped', params: {} });
    await run;
    expect(client.calls.map((call) => call.method)).toContain('session/load');
    expect(client.calls.map((call) => call.method)).not.toContain('session/new');
    expect(client.calls.filter((call) => call.method === 'session/set_config_option').map((call) => call.params)).toEqual([
      { sessionId: 'existing', configId: 'mode', value: 'plan' },
    ]);
  });

  it('defaults Devin permission mode to bypass when unset or unknown', async () => {
    const { provider, client } = setup(null, { NUNCIO_DEVIN_PERMISSION_MODE: 'garbage' });
    const run = provider.execute('s1', 'hello', false, {
      cwd: '/tmp',
      model: 'devin:swe-1-7',
      emit: () => undefined,
    });
    while (!client.calls.some((call) => call.method === 'session/prompt')) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    client.emit({ method: '_cognition.ai/agent_stopped', params: {} });
    await run;
    expect(client.calls.filter((call) => call.method === 'session/set_config_option')).toEqual([
      {
        method: 'session/set_config_option',
        params: { sessionId: 'new-session', configId: 'mode', value: 'bypass' },
      },
    ]);
  });

  it('routes ACP permission through the approval hook once without double-emitting cards', async () => {
    const { provider, client, events } = setup();
    const approvals: unknown[] = [];
    let resolveApproval!: (result: { requestId: string; decision: 'approve' | 'deny' }) => void;
    const run = provider.execute('s1', 'hello', false, {
      cwd: '/tmp',
      emit: (event) => events.push(event),
      requestProviderApproval: (request) => {
        approvals.push(request);
        return new Promise((resolve) => {
          resolveApproval = resolve;
        });
      },
    });
    while (!client.calls.some((call) => call.method === 'session/prompt')) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    const params = {
      sessionId: 'spiced-emmental',
      toolCall: { toolCallId: 'functions.exec:0', title: 'git branch', kind: 'execute' },
      options: [
        { optionId: 'allow_once', name: 'Allow', kind: 'allow_once' },
        { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' },
      ],
    };
    client.emitRequest({ id: 7, method: 'session/request_permission', params });

    await waitUntil(() => approvals.length === 1);
    expect(approvals[0]).toMatchObject({
      provider: 'devin',
      method: 'session/request_permission',
      params,
    });
    // SessionsService owns the transcript card — provider must not emit a second one.
    expect(events.filter((event) => event.type === 'provider_request')).toHaveLength(0);
    expect(client.responses).toEqual([]);

    resolveApproval({ requestId: 'nuncio-req', decision: 'approve' });
    await waitUntil(() => client.responses.length === 1);
    expect(client.responses[0]).toEqual({
      id: 7,
      result: { outcome: { outcome: 'selected', optionId: 'allow_once' } },
    });
    expect(events.filter((event) => event.type === 'provider_request_resolved')).toHaveLength(0);

    client.emit({ method: '_cognition.ai/agent_stopped', params: {} });
    await run;
  });

  it('maps deny onto the ACP reject optionId', async () => {
    const { provider, client } = setup();
    const run = provider.execute('s1', 'hello', false, {
      cwd: '/tmp',
      emit: () => undefined,
      requestProviderApproval: async () => ({ requestId: 'n1', decision: 'deny' }),
    });
    while (!client.calls.some((call) => call.method === 'session/prompt')) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    client.emitRequest({
      id: 'perm-deny',
      method: 'session/request_permission',
      params: {
        options: [
          { optionId: 'allow_once', name: 'Allow', kind: 'allow_once' },
          { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' },
        ],
      },
    });
    await waitUntil(() => client.responses.length === 1);
    expect(client.responses[0]).toEqual({
      id: 'perm-deny',
      result: { outcome: { outcome: 'selected', optionId: 'reject_once' } },
    });
    client.emit({ method: '_cognition.ai/agent_stopped', params: {} });
    await run;
  });

  it('maps ACP tool_call updates onto shared tool_start/tool_end payloads', async () => {
    const { provider, client, events } = setup();
    const run = provider.execute('s1', 'hello', false, {
      cwd: '/tmp',
      emit: (event) => events.push(event),
    });
    while (!client.calls.some((call) => call.method === 'session/prompt')) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    client.emit({
      method: 'session/update',
      params: {
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'functions.exec:0',
          title: 'git branch',
          kind: 'execute',
          rawInput: { command: 'git branch' },
        },
      },
    });
    client.emit({
      method: 'session/update',
      params: {
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'functions.exec:0',
          status: 'in_progress',
        },
      },
    });
    client.emit({
      method: 'session/update',
      params: {
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'functions.exec:0',
          status: 'completed',
          content: [{ type: 'content', content: { type: 'text', text: 'main' } }],
        },
      },
    });
    client.emit({ method: '_cognition.ai/agent_stopped', params: {} });
    await run;

    expect(events.filter((event) => event.type === 'tool_start')).toEqual([
      expect.objectContaining({
        type: 'tool_start',
        payload: {
          callId: 'functions.exec:0',
          tool: 'exec',
          input: { command: 'git branch' },
        },
      }),
    ]);
    expect(events.filter((event) => event.type === 'tool_end')).toEqual([
      expect.objectContaining({
        type: 'tool_end',
        payload: expect.objectContaining({
          callId: 'functions.exec:0',
        }),
      }),
    ]);
  });

  it('rejects an in-flight prompt when the ACP client closes', async () => {
    const { provider, client } = setup();
    const run = provider.execute('s1', 'hello', false, { cwd: '/tmp' });
    while (!client.calls.some((call) => call.method === 'session/prompt')) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    const error = new Error('ACP process exited');
    client.emitClose(error);

    await expect(run).rejects.toBe(error);
  });

  it('forwards image attachments through the advertised ACP image prompt capability', async () => {
    const { provider, client } = setup();
    const run = provider.execute('s1', 'inspect this', false, {
      cwd: '/tmp',
      attachments: [{ kind: 'image', mimeType: 'image/png', data: 'base64-opaque' }],
    });
    await waitUntil(() => client.calls.some((call) => call.method === 'session/prompt'));

    expect(client.calls.find((call) => call.method === 'session/prompt')).toEqual({
      method: 'session/prompt',
      timeoutMs: null,
      params: {
        sessionId: 'new-session',
        prompt: [
          { type: 'text', text: 'inspect this' },
          { type: 'image', data: 'base64-opaque', mimeType: 'image/png' },
        ],
      },
    });
    client.emit({ method: '_cognition.ai/agent_stopped', params: {} });
    await run;
  });

  it('keeps text-only prompts unchanged when attachments are empty', async () => {
    const { provider, client } = setup();
    const run = provider.execute('s1', 'text only', false, { cwd: '/tmp', attachments: [] });
    await waitUntil(() => client.calls.some((call) => call.method === 'session/prompt'));

    expect(client.calls.find((call) => call.method === 'session/prompt')?.params).toEqual({
      sessionId: 'new-session',
      prompt: [{ type: 'text', text: 'text only' }],
    });
    client.emit({ method: '_cognition.ai/agent_stopped', params: {} });
    await run;
  });

  it('switches the model on the live ACP session before the session row can change', async () => {
    const { provider, client } = setup();
    const run = provider.execute('s1', 'hello', false, { cwd: '/tmp' });
    await waitUntil(() => client.calls.some((call) => call.method === 'session/prompt'));
    client.emit({ method: '_cognition.ai/agent_stopped', params: {} });
    await run;

    const switchable = provider as DevinAgentProvider & {
      setModel(sessionId: string, model: string): Promise<void>;
    };
    await switchable.setModel('s1', 'devin:adaptive');

    expect(client.calls.at(-1)).toEqual({
      method: 'session/set_config_option',
      params: { sessionId: 'new-session', configId: 'model', value: 'adaptive' },
    });
  });

  it('does not send a model switch when no live ACP session exists', async () => {
    const { provider, client } = setup();
    const switchable = provider as DevinAgentProvider & {
      setModel(sessionId: string, model: string): Promise<void>;
    };

    await switchable.setModel('missing', 'devin:adaptive');

    expect(client.calls).toEqual([]);
  });

  it('surfaces a rejected live model switch instead of claiming success', async () => {
    const { provider, client } = setup();
    const run = provider.execute('s1', 'hello', false, { cwd: '/tmp' });
    await waitUntil(() => client.calls.some((call) => call.method === 'session/prompt'));
    client.emit({ method: '_cognition.ai/agent_stopped', params: {} });
    await run;
    client.requestHandler = (method) => {
      if (method === 'session/set_config_option') throw new Error('model rejected');
      return {};
    };

    await expect(provider.setModel('s1', 'devin:adaptive')).rejects.toThrow('model rejected');
  });

  it('maps ACP plan snapshots to the shared replace-all plan payload', async () => {
    const { provider, client, events } = setup();
    const run = provider.execute('s1', 'plan it', false, {
      cwd: '/tmp',
      emit: (event) => events.push(event),
    });
    await waitUntil(() => client.calls.some((call) => call.method === 'session/prompt'));
    client.emit({
      method: 'session/update',
      params: {
        update: {
          sessionUpdate: 'plan',
          entries: [
            { content: 'Inspect 世界', priority: 'high', status: 'in_progress' },
            { content: 'Ship', priority: 'medium', status: 'completed' },
          ],
        },
      },
    });
    client.emit({ method: '_cognition.ai/agent_stopped', params: {} });
    await run;

    expect(events.find((event) => event.type === 'plan_updated')?.payload).toEqual({
      items: [
        { id: 'item-1', text: 'Inspect 世界', status: 'in_progress' },
        { id: 'item-2', text: 'Ship', status: 'done' },
      ],
    });
  });

  it('emits an empty shared plan snapshot to clear a prior plan', async () => {
    const { provider, client, events } = setup();
    const run = provider.execute('s1', 'clear plan', false, {
      cwd: '/tmp',
      emit: (event) => events.push(event),
    });
    await waitUntil(() => client.calls.some((call) => call.method === 'session/prompt'));
    client.emit({
      method: 'session/update',
      params: { update: { sessionUpdate: 'plan', entries: [] } },
    });
    client.emit({ method: '_cognition.ai/agent_stopped', params: {} });
    await run;

    expect(events.find((event) => event.type === 'plan_updated')?.payload).toEqual({ items: [] });
  });
});
