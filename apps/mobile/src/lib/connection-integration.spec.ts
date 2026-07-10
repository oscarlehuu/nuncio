import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  subscribeSessionEvents,
  type SessionSubscription,
  type WebSocketLike,
} from '@nuncio/core/session-relay-client';
import { createConnectionManager, type ConnectionManager } from './connection-manager';

/**
 * End-to-end wiring test: the REAL relay client driven by the REAL connection
 * manager over a fake socket. This is the seam that unit-green pieces hid — it
 * proves the manager actually owns failover and freezes reconnection, not just
 * that each half works in isolation.
 */
class FakeSocket implements WebSocketLike {
  static instances: FakeSocket[] = [];
  sent: Array<Record<string, unknown>> = [];
  closed = false;
  readonly url: string;
  private listeners = new Map<string, Array<(event: { data?: unknown }) => void>>();

  constructor(url: string) {
    this.url = url;
    FakeSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }

  close(): void {
    if (this.closed) return;
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

/**
 * Wires a real relay + real manager exactly as use-session-transcript does:
 * onClose → handleClose, shouldReconnect → manager.shouldReconnect, onNotice →
 * handleNotice, and manager.resync reopens/resubscribes the subscription.
 */
function wire(options: { probe: () => Promise<string | null>; candidateUrls: string[] }) {
  let subscription: SessionSubscription | null = null;
  let manager: ConnectionManager;
  let appStateCb: ((active: boolean) => void) | null = null;
  let netInfoCb: (() => void) | null = null;
  const timers: Array<() => void> = [];

  const openSubscription = () => {
    subscription?.close();
    subscription = subscribeSessionEvents({
      url: 'ws://a/api/sessions/ws',
      sessionId: 's1',
      onEvent: () => {},
      onNotice: (n) => manager.handleNotice(n),
      onOpen: () => manager.handleOpen(),
      onClose: () => manager.handleClose(),
      shouldReconnect: () => manager.shouldReconnect(),
      webSocketFactory: (url) => new FakeSocket(url),
    });
  };

  manager = createConnectionManager({
    candidateUrls: options.candidateUrls,
    initialUrl: 'http://a',
    probe: options.probe,
    onActiveUrl: () => {}, // api-client repoint is out of scope for this wiring test
    reopen: openSubscription,
    resync: () => subscription?.resync(),
    subscribeNetInfo: (cb) => {
      netInfoCb = cb;
      return () => {
        netInfoCb = null;
      };
    },
    subscribeAppState: (cb) => {
      appStateCb = cb;
      return () => {
        appStateCb = null;
      };
    },
    setTimer: (fn) => {
      timers.push(fn);
      return timers.length as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: () => {},
    random: () => 0,
  });

  openSubscription();
  manager.start();

  return {
    manager,
    appState: (active: boolean) => appStateCb?.(active),
    netInfo: () => netInfoCb?.(),
    fireTimers: () => {
      const due = timers.splice(0, timers.length);
      for (const fn of due) fn();
    },
    tick: async () => {
      await Promise.resolve();
      await Promise.resolve();
    },
    call: (method: string, params: Record<string, unknown>) => subscription!.call(method, params),
  };
}

beforeEach(() => {
  FakeSocket.instances = [];
});
afterEach(() => {
  vi.useRealTimers();
});

it('foreground resync preserves an in-flight steer RPC on the healthy socket', async () => {
  const h = wire({ probe: async () => 'http://a', candidateUrls: ['http://a'] });
  const first = FakeSocket.instances[0];
  first.open();
  const steering = h.call('steer', { sessionId: 's1', message: 'keep me' });
  const request = first.sent[first.sent.length - 1];
  let outcome: unknown = 'pending';
  void steering.then(
    (value) => { outcome = value; },
    (error) => { outcome = error; },
  );

  h.appState(true);
  await h.tick();
  expect(FakeSocket.instances).toHaveLength(1);
  first.push({ id: request!.id, result: { status: 'RUNNING' } });
  await h.tick();

  expect(outcome).toEqual({ status: 'RUNNING' });
});

describe('relay + connection manager integration', () => {
  it('server_shutdown suppresses relay reconnect until an AppState kick', async () => {
    const h = wire({ probe: async () => 'http://a', candidateUrls: ['http://a'] });
    const first = FakeSocket.instances[0];
    first.open(); // initial socket connects → manager 'connected'
    expect(h.manager.getState()).toBe('connected');
    const socketsAfterOpen = FakeSocket.instances.length;

    // Server announces shutdown, then the socket drops.
    first.push({ notice: 'server_shutdown' });
    expect(h.manager.getState()).toBe('server-shutdown');
    first.close();
    await h.tick();

    // No new socket: the relay's own reconnect was suppressed AND the manager
    // did not probe/reopen while frozen.
    expect(FakeSocket.instances.length).toBe(socketsAfterOpen);

    // Foregrounding thaws it → the manager probes and reopens.
    h.appState(true);
    await h.tick();
    const reopened = FakeSocket.instances[FakeSocket.instances.length - 1];
    expect(FakeSocket.instances.length).toBeGreaterThan(socketsAfterOpen);
    reopened.open();
    expect(reopened.sent[0]).toMatchObject({ method: 'subscribe' });
    expect(h.manager.getState()).toBe('connected');
  });

  it('a NetInfo change alone thaws a server_shutdown freeze', async () => {
    const h = wire({ probe: async () => 'http://a', candidateUrls: ['http://a'] });
    const first = FakeSocket.instances[0];
    first.open();
    expect(h.manager.getState()).toBe('connected');
    const socketsAfterOpen = FakeSocket.instances.length;

    first.push({ notice: 'server_shutdown' });
    first.close();
    await h.tick();
    expect(FakeSocket.instances.length).toBe(socketsAfterOpen); // frozen, no reconnect

    // A network/Tailscale recovery with the app still foregrounded (no AppState)
    // must reconnect on its own.
    h.netInfo();
    await h.tick();
    const reopened = FakeSocket.instances[FakeSocket.instances.length - 1];
    expect(FakeSocket.instances.length).toBeGreaterThan(socketsAfterOpen);
    reopened.open();
    expect(h.manager.getState()).toBe('connected');
  });

  it('a server_shutdown cooldown reopens the relay without AppState or NetInfo', async () => {
    const h = wire({ probe: async () => 'http://a', candidateUrls: ['http://a'] });
    const first = FakeSocket.instances[0];
    first.open();
    const socketsAfterOpen = FakeSocket.instances.length;

    first.push({ notice: 'server_shutdown' });
    first.close();
    await h.tick();
    expect(FakeSocket.instances.length).toBe(socketsAfterOpen);

    h.fireTimers();
    await h.tick();

    const reopened = FakeSocket.instances[FakeSocket.instances.length - 1];
    expect(FakeSocket.instances.length).toBeGreaterThan(socketsAfterOpen);
    reopened.open();
    expect(reopened.sent[0]).toMatchObject({ method: 'subscribe', params: { since: 0 } });
    expect(h.manager.getState()).toBe('connected');
  });

  it('an ordinary socket drop drives the manager to probe and reopen', async () => {
    const h = wire({ probe: async () => 'http://a', candidateUrls: ['http://a', 'http://b'] });
    const first = FakeSocket.instances[0];
    first.open();
    expect(h.manager.getState()).toBe('connected');
    const before = FakeSocket.instances.length;

    first.close(); // ordinary drop, no shutdown
    await h.tick();

    // The manager re-probed and reopened a fresh subscription.
    const latest = FakeSocket.instances[FakeSocket.instances.length - 1];
    expect(FakeSocket.instances.length).toBeGreaterThan(before);
    expect(latest.url).toBe('ws://a/api/sessions/ws');
    latest.open();
    expect(latest.sent[0]).toMatchObject({ method: 'subscribe', params: { sessionId: 's1' } });
    expect(h.manager.getState()).toBe('connected');
  });

  it('offline drop backs off, then reconnects when a candidate returns', async () => {
    let healthy = true;
    const h = wire({
      probe: async () => (healthy ? 'http://a' : null),
      candidateUrls: ['http://a'],
    });
    const first = FakeSocket.instances[0];
    first.open();
    expect(h.manager.getState()).toBe('connected');
    const before = FakeSocket.instances.length;

    healthy = false;
    first.close(); // drops while the network is down
    await h.tick();
    expect(h.manager.getState()).toBe('offline');
    // No socket reopened yet — the relay did not self-reconnect behind the
    // manager, and the manager is waiting out a backoff timer.
    expect(FakeSocket.instances.length).toBe(before);

    healthy = true;
    h.fireTimers(); // the scheduled backoff retry fires
    await h.tick();
    const latest = FakeSocket.instances[FakeSocket.instances.length - 1];
    expect(FakeSocket.instances.length).toBeGreaterThan(before);
    latest.open();
    expect(h.manager.getState()).toBe('connected');
  });
});
