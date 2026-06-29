import { describe, expect, it } from 'bun:test';
import { EventEmitter } from 'node:events';
import {
  CodexAppServerClient,
  type CodexAppServerTransport,
} from '../../../src/agents/providers/codex-app-server.client';

class FakeTransport extends EventEmitter implements CodexAppServerTransport {
  readonly sent: unknown[] = [];
  closed = false;

  send(message: unknown): void {
    this.sent.push(message);
  }

  close(): void {
    this.closed = true;
  }

  emitJson(message: unknown): void {
    this.emit('line', JSON.stringify(message));
  }
}

describe('CodexAppServerClient', () => {
  it('correlates JSON-RPC request responses by id', async () => {
    const transport = new FakeTransport();
    const client = new CodexAppServerClient(transport);

    const result = client.request<{ ok: true }>('model/list', {});
    expect(transport.sent).toEqual([{ id: 1, method: 'model/list', params: {} }]);

    transport.emitJson({ id: 1, result: { ok: true } });

    await expect(result).resolves.toEqual({ ok: true });
  });

  it('emits notifications without resolving pending requests', async () => {
    const transport = new FakeTransport();
    const client = new CodexAppServerClient(transport);
    const notifications: Array<{ method: string; params?: unknown }> = [];
    client.onNotification((notification) => notifications.push(notification));

    const result = client.request<{ turn: { id: string } }>('turn/start', { threadId: 'thread-1' });
    transport.emitJson({
      method: 'item/agentMessage/delta',
      params: { threadId: 'thread-1', turnId: 'turn-1', delta: 'Hi' },
    });
    transport.emitJson({ id: 1, result: { turn: { id: 'turn-1' } } });

    await expect(result).resolves.toEqual({ turn: { id: 'turn-1' } });
    expect(notifications).toEqual([
      {
        method: 'item/agentMessage/delta',
        params: { threadId: 'thread-1', turnId: 'turn-1', delta: 'Hi' },
      },
    ]);
  });

  it('surfaces server requests and lets the caller respond', () => {
    const transport = new FakeTransport();
    const client = new CodexAppServerClient(transport);
    const requests: Array<{ id: string | number; method: string; params?: unknown }> = [];
    client.onServerRequest((request) => requests.push(request));

    transport.emitJson({
      id: 99,
      method: 'item/commandExecution/requestApproval',
      params: { command: 'rm -rf build' },
    });
    client.respond(99, { decision: 'deny' });

    expect(requests).toEqual([
      {
        id: 99,
        method: 'item/commandExecution/requestApproval',
        params: { command: 'rm -rf build' },
      },
    ]);
    expect(transport.sent).toEqual([{ id: 99, result: { decision: 'deny' } }]);
  });

  it('rejects pending requests when the transport exits', async () => {
    const transport = new FakeTransport();
    const client = new CodexAppServerClient(transport);
    const result = client.request('thread/start', {});

    transport.emit('exit', 1, null);

    await expect(result).rejects.toThrow('codex app-server exited');
  });

  it('notifies close listeners when the transport exits', () => {
    const transport = new FakeTransport();
    const client = new CodexAppServerClient(transport);
    const errors: string[] = [];

    client.onClose((error) => errors.push(error.message));
    transport.emit('exit', 1, null);

    expect(errors).toEqual(['codex app-server exited (code=1, signal=null).']);
  });
});
