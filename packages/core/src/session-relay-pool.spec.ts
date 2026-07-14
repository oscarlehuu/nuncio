import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionEvent } from './api';
import { subscribeSessionEvents, type WebSocketLike } from './session-relay-client';
import { resetBrowserSessionRelayPoolForTests } from './session-relay-pool';

class FakeSocket implements WebSocketLike {
  static instances: FakeSocket[] = [];
  readonly sent: Array<Record<string, unknown>> = [];
  closed = false;
  private readonly listeners = new Map<string, Array<(event: { data?: unknown }) => void>>();
  readonly url: string;

  constructor(url: string) {
    this.url = url;
    FakeSocket.instances.push(this);
  }

  addEventListener(type: string, listener: (event: { data?: unknown }) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }

  close(): void {
    this.closed = true;
    this.fire('close', {});
  }

  fire(type: string, event: { data?: unknown }): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  open(): void {
    this.fire('open', {});
  }

  push(frame: unknown): void {
    this.fire('message', { data: JSON.stringify(frame) });
  }
}

function event(seq: number): SessionEvent {
  return { seq, type: 'assistant_delta', payload: { delta: String(seq) }, createdAt: seq };
}

function messages(socket: FakeSocket, method: string): Array<Record<string, unknown>> {
  return socket.sent.filter((message) => message.method === method);
}

const originalWebSocket = globalThis.WebSocket;

beforeEach(() => {
  vi.useFakeTimers();
  FakeSocket.instances = [];
  (globalThis as unknown as { WebSocket: typeof FakeSocket }).WebSocket = FakeSocket;
});

afterEach(() => {
  resetBrowserSessionRelayPoolForTests();
  if (originalWebSocket) globalThis.WebSocket = originalWebSocket;
  else delete (globalThis as { WebSocket?: unknown }).WebSocket;
  vi.useRealTimers();
});

describe('browser session relay pool', () => {
  it('survives a StrictMode-like immediate release and reacquire without socket churn', () => {
    const first = subscribeSessionEvents({ url: 'ws://x', sessionId: 's1', onEvent: () => {} });
    const socket = FakeSocket.instances[0]!;
    socket.open();

    first.close();
    expect(socket.closed).toBe(false);
    const second = subscribeSessionEvents({ url: 'ws://x', sessionId: 's1', onEvent: () => {} });
    expect(FakeSocket.instances).toHaveLength(1);

    second.close();
    vi.runOnlyPendingTimers();
    expect(socket.closed).toBe(true);
  });

  it('reconnects one socket and restores independent channel cursors', () => {
    const first = subscribeSessionEvents({ url: 'ws://x', sessionId: 's1', since: 2, onEvent: () => {} });
    const second = subscribeSessionEvents({ url: 'ws://x', sessionId: 's2', since: 8, onEvent: () => {} });
    const initial = FakeSocket.instances[0]!;
    initial.open();
    initial.push({ channel: 's1', event: event(4) });
    initial.push({ channel: 's2', event: event(11) });
    initial.fire('close', {});

    vi.advanceTimersByTime(2_000);
    expect(FakeSocket.instances).toHaveLength(2);
    const reconnected = FakeSocket.instances[1]!;
    reconnected.open();
    expect(messages(reconnected, 'subscribe').map((message) => message.params)).toEqual([
      { sessionId: 's1', since: 4 },
      { sessionId: 's2', since: 11 },
    ]);
    first.close();
    second.close();
  });

  it('resubscribes from lastSeq on server_shutdown without wiping delivery', () => {
    const seen: number[] = [];
    const sub = subscribeSessionEvents({
      url: 'ws://x',
      sessionId: 's1',
      since: 1,
      onEvent: (e) => seen.push(e.seq),
    });
    const socket = FakeSocket.instances[0]!;
    socket.open();
    socket.push({ channel: 's1', event: event(3) });
    const before = messages(socket, 'subscribe').length;

    socket.push({ notice: 'server_shutdown' });
    expect(messages(socket, 'subscribe')).toHaveLength(before + 1);
    expect(messages(socket, 'subscribe').at(-1)?.params).toEqual({ sessionId: 's1', since: 3 });
    expect(seen).toEqual([3]);

    socket.push({ channel: 's1', event: event(4) });
    expect(seen).toEqual([3, 4]);
    sub.close();
  });

  it('recovers a behind channel without disturbing its neighbor', () => {
    const first = subscribeSessionEvents({ url: 'ws://x', sessionId: 's1', since: 1, onEvent: () => {} });
    const second = subscribeSessionEvents({ url: 'ws://x', sessionId: 's2', since: 7, onEvent: () => {} });
    const socket = FakeSocket.instances[0]!;
    socket.open();
    socket.push({ channel: 's1', event: event(3) });
    const before = messages(socket, 'subscribe').length;

    socket.push({ channel: 's1', behind: true });
    expect(messages(socket, 'subscribe')).toHaveLength(before + 1);
    expect(messages(socket, 'subscribe').at(-1)?.params).toEqual({ sessionId: 's1', since: 3 });
    first.close();
    second.close();
  });

  it('fans out one server channel without replaying below a consumer cursor', () => {
    const seenA: number[] = [];
    const seenB: number[] = [];
    const first = subscribeSessionEvents({ url: 'ws://x', sessionId: 's1', since: 2, onEvent: (e) => seenA.push(e.seq) });
    const second = subscribeSessionEvents({ url: 'ws://x', sessionId: 's1', since: 5, onEvent: (e) => seenB.push(e.seq) });
    const socket = FakeSocket.instances[0]!;
    socket.open();
    expect(messages(socket, 'subscribe')).toHaveLength(1);
    expect(messages(socket, 'subscribe')[0]?.params).toEqual({ sessionId: 's1', since: 2 });

    socket.push({ channel: 's1', event: event(3) });
    socket.push({ channel: 's1', event: event(4) });
    socket.push({ channel: 's1', event: event(6) });
    expect(seenA).toEqual([3, 4, 6]);
    expect(seenB).toEqual([6]);
    first.close();
    expect(messages(socket, 'unsubscribe')).toHaveLength(0);
    second.close();
    expect(messages(socket, 'unsubscribe')).toHaveLength(1);
  });

  it('isolates pending RPC ownership when one logical subscription closes', async () => {
    const first = subscribeSessionEvents({ url: 'ws://x', sessionId: 's1', onEvent: () => {} });
    const second = subscribeSessionEvents({ url: 'ws://x', sessionId: 's2', onEvent: () => {} });
    const socket = FakeSocket.instances[0]!;
    socket.open();
    const abandoned = first.call('steer', { sessionId: 's1', message: 'a' });
    const live = second.call('steer', { sessionId: 's2', message: 'b' });
    const calls = messages(socket, 'steer');

    first.close();
    await expect(abandoned).rejects.toThrow('connection closed');
    socket.push({ id: calls[1]!.id, result: { status: 'RUNNING' } });
    await expect(live).resolves.toEqual({ status: 'RUNNING' });
    second.close();
  });

  it('makes resync and confirmation inert after the logical subscription closes', async () => {
    const first = subscribeSessionEvents({ url: 'ws://x', sessionId: 's1', onEvent: () => {} });
    const second = subscribeSessionEvents({ url: 'ws://x', sessionId: 's2', onEvent: () => {} });
    const socket = FakeSocket.instances[0]!;
    socket.open();
    first.close();
    const subscribeCount = messages(socket, 'subscribe').length;

    first.resync();
    expect(messages(socket, 'subscribe')).toHaveLength(subscribeCount);
    await expect(first.confirmResync()).resolves.toBe(false);
    expect(messages(socket, 'subscribe')).toHaveLength(subscribeCount);
    second.close();
  });

  it('rejects RPCs issued after the logical subscription closes', async () => {
    const first = subscribeSessionEvents({ url: 'ws://x', sessionId: 's1', onEvent: () => {} });
    const second = subscribeSessionEvents({ url: 'ws://x', sessionId: 's2', onEvent: () => {} });
    const socket = FakeSocket.instances[0]!;
    socket.open();
    first.close();

    const closedCall = first.call('steer', { sessionId: 's1', message: 'late' });
    const calls = messages(socket, 'steer');
    if (calls[0]) socket.push({ id: calls[0].id, result: { status: 'RUNNING' } });
    expect(calls).toHaveLength(0);
    await expect(closedCall).rejects.toThrow('connection closed');
    second.close();
  });
});
