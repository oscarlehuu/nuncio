import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DevinAgentProvider } from '../../../src/agents/providers/devin-agent.provider';
import type { AgentRunContext } from '../../../src/agents/agents.types';
import type { DevinAcpClientLike, DevinAcpError } from '../../../src/agents/providers/devin-acp.client';

class TestProvider extends DevinAgentProvider {
  execute(id: string, context: AgentRunContext): Promise<void> {
    return this.executePrompt(id, 'filesystem callback', false, context);
  }
}

class FakeClient implements DevinAcpClientLike {
  readonly calls: string[] = [];
  readonly responses: Array<{ id: string | number; result?: unknown; error?: DevinAcpError }> = [];
  private notification?: (value: { method: string; params?: unknown }) => void;
  private serverRequest?: (value: { id: string | number; method: string; params?: unknown }) => void;
  private closeHandler?: (error: Error) => void;

  async initialize(): Promise<void> {}
  async request<T>(method: string): Promise<T> {
    this.calls.push(method);
    return (method === 'session/new' ? { sessionId: 'devin-fs' } : {}) as T;
  }
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
  respond(id: string | number, result: unknown): void { this.responses.push({ id, result }); }
  respondError(id: string | number, error: DevinAcpError): void { this.responses.push({ id, error }); }
  close(): void {}
  emitRequest(value: { id: string | number; method: string; params?: unknown }): void {
    this.serverRequest?.(value);
  }
  stop(): void { this.notification?.({ method: '_cognition.ai/agent_stopped', params: {} }); }
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > 1_000) throw new Error('waitUntil timed out');
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function setup(cwd: string): { provider: TestProvider; client: FakeClient } {
  const state = { providerThreadId: null as string | null, providerState: null as Record<string, unknown> | null };
  const sessions = {
    findById: () => state,
    updateProviderRuntimeState: (_id: string, update: { providerThreadId?: string | null; providerState?: Record<string, unknown> }) => {
      if (update.providerThreadId !== undefined) state.providerThreadId = update.providerThreadId;
      if (update.providerState !== undefined) state.providerState = update.providerState;
      return state;
    },
  };
  const events = { append: (_id: string, type: string, payload: unknown) => ({ seq: 1, type, payload }) };
  const settings = { resolve: () => undefined };
  const provider = new TestProvider(sessions as never, events as never, settings as never);
  const client = new FakeClient();
  provider.clientFactory = () => client;
  return { provider, client };
}

async function runCallbackCase(
  cwd: string,
  request: { id: string | number; method: string; params?: unknown },
): Promise<{
  response: FakeClient['responses'][number] | undefined;
  responseCount: number;
  unhandled: unknown[];
}> {
  const { provider, client } = setup(cwd);
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  const run = provider.execute('s1', { cwd });
  try {
    await waitUntil(() => client.calls.includes('session/prompt'));
    client.emitRequest(request);
    await waitUntil(() => client.responses.length === 1 || unhandled.length > 0);
    await new Promise((resolve) => setTimeout(resolve, 10));
    return { response: client.responses[0], responseCount: client.responses.length, unhandled };
  } finally {
    client.stop();
    await run;
    process.off('unhandledRejection', onUnhandled);
  }
}

describe('DevinAgentProvider filesystem callbacks', () => {
  let cwd: string;

  beforeEach(() => { cwd = mkdtempSync(join(tmpdir(), 'nuncio-devin-fs-')); });
  afterEach(() => { chmodSync(cwd, 0o700); rmSync(cwd, { recursive: true, force: true }); });

  it('returns one ACP error for a missing read with no unhandled rejection', async () => {
    const result = await runCallbackCase(cwd, {
      id: 'read-missing',
      method: 'fs/read_text_file',
      params: { path: 'missing.txt' },
    });

    expect(result.response).toMatchObject({
      id: 'read-missing',
      error: { code: -32002, message: 'File not found' },
    });
    expect(result.responseCount).toBe(1);
    expect(result.unhandled).toEqual([]);
  });

  it('returns one ACP error when the write parent is missing with no unhandled rejection', async () => {
    const result = await runCallbackCase(cwd, {
      id: 'write-missing-parent',
      method: 'fs/write_text_file',
      params: { path: 'missing/child.txt', content: 'data' },
    });

    expect(result.response).toMatchObject({ id: 'write-missing-parent', error: { code: -32002 } });
    expect(result.responseCount).toBe(1);
    expect(result.unhandled).toEqual([]);
  });

  it('returns one ACP error when the write parent is not writable', async () => {
    chmodSync(cwd, 0o500);
    const result = await runCallbackCase(cwd, {
      id: 'write-readonly-parent',
      method: 'fs/write_text_file',
      params: { path: 'child.txt', content: 'data' },
    });

    expect(result.response).toMatchObject({ id: 'write-readonly-parent', error: { code: -32603 } });
    expect(result.responseCount).toBe(1);
    expect(result.unhandled).toEqual([]);
  });

  it('rejects a missing callback path once instead of operating on the workspace root', async () => {
    const result = await runCallbackCase(cwd, { id: 9, method: 'fs/read_text_file', params: {} });

    expect(result.response).toEqual({
      id: 9,
      error: { code: -32602, message: 'File path is required' },
    });
    expect(result.responseCount).toBe(1);
    expect(result.unhandled).toEqual([]);
  });
});
