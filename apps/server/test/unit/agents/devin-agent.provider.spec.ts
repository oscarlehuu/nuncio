import { DevinAgentProvider } from '../../../src/agents/providers/devin-agent.provider';
import type { AgentRunContext } from '../../../src/agents/agents.types';

class TestProvider extends DevinAgentProvider {
  execute(id: string, text: string, steer: boolean, context: AgentRunContext): Promise<void> {
    return this.executePrompt(id, text, steer, context);
  }
}

class FakeClient {
  readonly calls: Array<{ method: string; params: unknown }> = [];
  private notification?: (value: { method: string; params?: unknown }) => void;
  private serverRequest?: (value: { id: string | number; method: string; params?: unknown }) => void;
  private closeHandler?: (error: Error) => void;
  requestHandler?: (method: string, params: unknown) => unknown;
  initialize = async () => undefined;
  request = async <T>(method: string, params: unknown): Promise<T> => {
    this.calls.push({ method, params });
    return (this.requestHandler?.(method, params) ?? {}) as T;
  };
  onNotification(listener: (value: { method: string; params?: unknown }) => void): () => void { this.notification = listener; return () => undefined; }
  onServerRequest(listener: (value: { id: string | number; method: string; params?: unknown }) => void): () => void { this.serverRequest = listener; return () => undefined; }
  onClose(listener: (error: Error) => void): () => void {
    this.closeHandler = listener;
    return () => {
      this.closeHandler = undefined;
    };
  }
  respond(): void {}
  close(): void {}
  emit(value: { method: string; params?: unknown }): void { this.notification?.(value); }
  emitRequest(value: { id: string | number; method: string; params?: unknown }): void { this.serverRequest?.(value); }
  emitClose(error: Error): void { this.closeHandler?.(error); }
}

describe('DevinAgentProvider', () => {
  function setup(providerThreadId: string | null = null) {
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
    const provider = new TestProvider(sessions as never, eventsRepo as never, { resolve: () => undefined } as never);
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
    expect(client.calls.map((call) => call.method)).toEqual(['session/new', 'session/set_mode', 'session/prompt']);
    expect((client.calls[1]?.params as { value: string }).value).toBe('swe-1-7-medium');
    expect(state.providerThreadId).toBe('new-session');
    expect(events.map((event) => event.type)).toEqual(['thinking_delta', 'assistant_delta', 'assistant_message']);
  });

  it('loads a persisted session instead of creating a new one', async () => {
    const { provider, client } = setup('existing');
    const run = provider.execute('s1', 'hello', false, { cwd: '/tmp', emit: () => undefined });
    while (!client.calls.some((call) => call.method === 'session/prompt')) await new Promise((resolve) => setTimeout(resolve, 0));
    client.emit({ method: '_cognition.ai/agent_stopped', params: {} });
    await run;
    expect(client.calls.map((call) => call.method)).toContain('session/load');
    expect(client.calls.map((call) => call.method)).not.toContain('session/new');
  });

  it('maps ACP permission requests through the provider approval hook', async () => {
    const { provider, client, events } = setup();
    const approval = async () => ({ requestId: '7', decision: 'approve' as const });
    const run = provider.execute('s1', 'hello', false, { cwd: '/tmp', emit: (event) => events.push(event), requestProviderApproval: approval });
    while (!client.calls.some((call) => call.method === 'session/prompt')) await new Promise((resolve) => setTimeout(resolve, 0));
    client.emitRequest({ id: 7, method: 'session/request_permission', params: { tool: 'write' } });
    client.emit({ method: '_cognition.ai/agent_stopped', params: {} });
    await run;
    expect(events.map((event) => event.type)).toContain('provider_request');
    expect(events.map((event) => event.type)).toContain('provider_request_resolved');
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
});
