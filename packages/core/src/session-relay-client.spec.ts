import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { subscribeSessionEvents, type WebSocketLike } from './session-relay-client';
import type { SessionEvent } from './api';

class FakeSocket implements WebSocketLike {
  static instances: FakeSocket[] = [];
  sent: Array<Record<string, unknown>> = [];
  closed = false;
  private listeners = new Map<string, Array<(event: { data?: unknown }) => void>>();

  readonly url: string;

  constructor(url: string) {
    this.url = url;
    FakeSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }

  close(): void {
    this.closed = true;
    this.fire('close', {});
  }

  addEventListener(type: string, listener: (event: { data?: unknown }) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  fire(type: string, event: { data?: unknown }): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  open(): void {
    this.fire('open', {});
  }

  push(payload: unknown): void {
    this.fire('message', { data: JSON.stringify(payload) });
  }
}

function event(seq: number): SessionEvent {
  return { seq, type: 'assistant_delta', payload: {}, createdAt: seq };
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeSocket.instances = [];
});

afterEach(() => {
  vi.useRealTimers();
});

const factory = (url: string) => new FakeSocket(url);

describe('subscribeSessionEvents', () => {
  it('subscribes from the given cursor on open and forwards events', () => {
    const seen: number[] = [];
    subscribeSessionEvents({
      url: 'ws://x/api/sessions/ws',
      sessionId: 's1',
      since: 3,
      onEvent: (e) => seen.push(e.seq),
      webSocketFactory: factory,
    });
    const ws = FakeSocket.instances[0];
    ws.open();
    expect(ws.sent[0]).toMatchObject({ method: 'subscribe', params: { sessionId: 's1', since: 3 } });

    ws.push({ channel: 's1', event: event(4) });
    ws.push({ channel: 's1', event: event(5) });
    expect(seen).toEqual([4, 5]);
  });

  it('reconnects after a drop and resubscribes from the last seen seq', () => {
    const seen: number[] = [];
    subscribeSessionEvents({
      url: 'ws://x',
      sessionId: 's1',
      onEvent: (e) => seen.push(e.seq),
      webSocketFactory: factory,
      reconnectMs: 100,
    });
    const first = FakeSocket.instances[0];
    first.open();
    first.push({ channel: 's1', event: event(7) });
    first.fire('close', {});

    vi.advanceTimersByTime(100);
    const second = FakeSocket.instances[1];
    expect(second).toBeDefined();
    second.open();
    expect(second.sent[0]).toMatchObject({ method: 'subscribe', params: { sessionId: 's1', since: 7 } });
  });

  it('resubscribes from lastSeq when the server marks the stream behind', () => {
    subscribeSessionEvents({
      url: 'ws://x',
      sessionId: 's1',
      onEvent: () => {},
      webSocketFactory: factory,
    });
    const ws = FakeSocket.instances[0];
    ws.open();
    ws.push({ channel: 's1', event: event(9) });
    ws.push({ channel: 's1', behind: true });
    const resubscribe = ws.sent[ws.sent.length - 1];
    expect(resubscribe).toMatchObject({ method: 'subscribe', params: { sessionId: 's1', since: 9 } });
  });

  it('resync resubscribes on a live socket and reconnects on a dead one', () => {
    const sub = subscribeSessionEvents({
      url: 'ws://x',
      sessionId: 's1',
      onEvent: () => {},
      webSocketFactory: factory,
      reconnectMs: 60_000,
    });
    const ws = FakeSocket.instances[0];
    ws.open();
    ws.push({ channel: 's1', event: event(2) });

    sub.resync();
    expect(ws.sent[ws.sent.length - 1]).toMatchObject({ params: { since: 2 } });

    ws.fire('close', {});
    sub.resync(); // dead socket → immediate reconnect instead of waiting out the timer
    const second = FakeSocket.instances[1];
    expect(second).toBeDefined();
    second.open();
    expect(second.sent[0]).toMatchObject({ method: 'subscribe', params: { since: 2 } });
  });

  it('correlates RPC responses and rejects on server error', async () => {
    const sub = subscribeSessionEvents({
      url: 'ws://x',
      sessionId: 's1',
      onEvent: () => {},
      webSocketFactory: factory,
    });
    const ws = FakeSocket.instances[0];
    ws.open();

    const okCall = sub.call('steer', { sessionId: 's1', message: 'hi' });
    const okId = ws.sent[ws.sent.length - 1].id as number;
    ws.push({ id: okId, result: { status: 'RUNNING' } });
    await expect(okCall).resolves.toEqual({ status: 'RUNNING' });

    const failCall = sub.call('steer', { sessionId: 's1', message: 'hi' });
    const failId = ws.sent[ws.sent.length - 1].id as number;
    ws.push({ id: failId, error: { code: 409, message: 'busy' } });
    await expect(failCall).rejects.toEqual({ code: 409, message: 'busy' });
  });

  it('close() stops reconnecting and event delivery', () => {
    const seen: number[] = [];
    const sub = subscribeSessionEvents({
      url: 'ws://x',
      sessionId: 's1',
      onEvent: (e) => seen.push(e.seq),
      webSocketFactory: factory,
      reconnectMs: 100,
    });
    const ws = FakeSocket.instances[0];
    ws.open();
    sub.close();
    vi.advanceTimersByTime(1000);
    expect(FakeSocket.instances.length).toBe(1);
    ws.push({ channel: 's1', event: event(1) });
    expect(seen).toEqual([]);
  });
});
