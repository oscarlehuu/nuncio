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

  it('uses the reconnectDelays hook per attempt and resets the counter on open', () => {
    const attempts: number[] = [];
    subscribeSessionEvents({
      url: 'ws://x',
      sessionId: 's1',
      onEvent: () => {},
      webSocketFactory: factory,
      reconnectDelays: (attempt) => {
        attempts.push(attempt);
        return 10;
      },
    });
    const first = FakeSocket.instances[0];
    first.open();
    first.fire('close', {});
    expect(attempts).toEqual([1]); // first reconnect → attempt 1

    vi.advanceTimersByTime(10);
    const second = FakeSocket.instances[1];
    second.fire('close', {}); // never opened → attempt keeps climbing
    expect(attempts).toEqual([1, 2]);

    vi.advanceTimersByTime(10);
    const third = FakeSocket.instances[2];
    third.open(); // a successful open resets the storm counter
    third.fire('close', {});
    expect(attempts).toEqual([1, 2, 1]);
  });

  it('keeps fixed reconnectMs when no reconnectDelays hook is supplied', () => {
    subscribeSessionEvents({
      url: 'ws://x',
      sessionId: 's1',
      onEvent: () => {},
      webSocketFactory: factory,
      reconnectMs: 250,
    });
    const first = FakeSocket.instances[0];
    first.open();
    first.fire('close', {});
    // Nothing reconnects before the fixed delay elapses.
    vi.advanceTimersByTime(249);
    expect(FakeSocket.instances.length).toBe(1);
    vi.advanceTimersByTime(1);
    expect(FakeSocket.instances.length).toBe(2);
  });

  it('does NOT fire onClose for an intentional close() teardown', () => {
    let closes = 0;
    const sub = subscribeSessionEvents({
      url: 'ws://x',
      sessionId: 's1',
      onEvent: () => {},
      webSocketFactory: factory,
      onClose: () => {
        closes += 1;
      },
    });
    FakeSocket.instances[0].open();
    sub.close(); // deliberate teardown — an owner that reopens on close must not loop
    expect(closes).toBe(0);
  });

  it('fires onClose on a socket drop and still self-reconnects by default', () => {
    let closes = 0;
    subscribeSessionEvents({
      url: 'ws://x',
      sessionId: 's1',
      onEvent: () => {},
      webSocketFactory: factory,
      reconnectMs: 50,
      onClose: () => {
        closes += 1;
      },
    });
    const first = FakeSocket.instances[0];
    first.open();
    first.fire('close', {});
    expect(closes).toBe(1);
    vi.advanceTimersByTime(50);
    expect(FakeSocket.instances.length).toBe(2); // onClose does not suppress reconnect
  });

  it('suppresses its own reconnect while shouldReconnect returns false, then resync reopens it', () => {
    let allow = false;
    const sub = subscribeSessionEvents({
      url: 'ws://x',
      sessionId: 's1',
      onEvent: () => {},
      webSocketFactory: factory,
      reconnectMs: 50,
      shouldReconnect: () => allow,
    });
    const first = FakeSocket.instances[0];
    first.open();
    first.fire('close', {});
    vi.advanceTimersByTime(1000);
    expect(FakeSocket.instances.length).toBe(1); // frozen: no reconnect scheduled

    // The owner thaws (its state cleared) and drives reconnection itself.
    allow = true;
    sub.resync();
    const second = FakeSocket.instances[1];
    expect(second).toBeDefined();
    second.open();
    expect(second.sent[0]).toMatchObject({ method: 'subscribe', params: { sessionId: 's1' } });
  });

  it('dispatches top-level notice frames to onNotice', () => {
    const notices: string[] = [];
    subscribeSessionEvents({
      url: 'ws://x',
      sessionId: 's1',
      onEvent: () => {},
      webSocketFactory: factory,
      onNotice: (n) => notices.push(n),
    });
    const ws = FakeSocket.instances[0];
    ws.open();
    ws.push({ notice: 'server_shutdown' });
    ws.push({ notice: 'something_else' }); // unknown notice still forwarded
    expect(notices).toEqual(['server_shutdown', 'something_else']);
  });

  it('ignores a notice frame when no onNotice is supplied', () => {
    const seen: number[] = [];
    subscribeSessionEvents({
      url: 'ws://x',
      sessionId: 's1',
      onEvent: (e) => seen.push(e.seq),
      webSocketFactory: factory,
    });
    const ws = FakeSocket.instances[0];
    ws.open();
    expect(() => ws.push({ notice: 'server_shutdown' })).not.toThrow();
    ws.push({ channel: 's1', event: event(1) });
    expect(seen).toEqual([1]); // event delivery still works after the notice
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
