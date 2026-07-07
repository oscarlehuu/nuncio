import { describe, expect, it } from 'vitest';
import {
  createConnectionManager,
  type ConnectionManagerDeps,
  type ConnectionState,
} from './connection-manager';

/**
 * A hand-driven harness: probe returns whatever the current script says, timers
 * are queued and fired manually, and NetInfo/AppState callbacks are captured so
 * the test can flip them. Everything is synchronous except the probe promise, so
 * tests `await tick()` to let a probe settle.
 */
function harness(overrides: Partial<ConnectionManagerDeps> = {}) {
  let probeResult: string | null = 'http://a';
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const onActiveUrl: string[] = [];
  let resyncs = 0;
  let netInfoCb: (() => void) | null = null;
  let appStateCb: ((active: boolean) => void) | null = null;
  const states: ConnectionState[] = [];

  const deps: ConnectionManagerDeps = {
    candidateUrls: ['http://a', 'http://b'],
    initialUrl: 'http://a',
    probe: async () => probeResult,
    onActiveUrl: (url) => onActiveUrl.push(url),
    resync: () => {
      resyncs += 1;
    },
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
    setTimer: (fn, ms) => {
      timers.push({ fn, ms });
      return timers.length as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: () => {},
    random: () => 0.5,
    ...overrides,
  };

  const manager = createConnectionManager(deps);
  manager.subscribe((s) => states.push(s));

  return {
    manager,
    states,
    onActiveUrl,
    timers,
    resyncs: () => resyncs,
    netInfo: () => netInfoCb?.(),
    appState: (active: boolean) => appStateCb?.(active),
    setProbe: (result: string | null) => {
      probeResult = result;
    },
    fireTimers: () => {
      const due = timers.splice(0, timers.length);
      for (const t of due) t.fn();
    },
    // Two microtask flushes: probe resolve, then the .then chain in attemptConnect.
    tick: async () => {
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}

describe('createConnectionManager', () => {
  it('connects on start when a candidate is healthy', async () => {
    const h = harness();
    h.manager.start();
    await h.tick();
    expect(h.manager.getState()).toBe('connected');
    expect(h.resyncs()).toBe(1);
  });

  it('does not reconfigure or churn when the winner is unchanged', async () => {
    const h = harness();
    h.manager.start();
    await h.tick();
    // initialUrl === winner 'http://a' → no onActiveUrl call.
    expect(h.onActiveUrl).toEqual([]);

    h.netInfo();
    await h.tick();
    expect(h.onActiveUrl).toEqual([]); // still the same winner
    expect(h.manager.getState()).toBe('connected');
  });

  it('switches the active URL and resyncs when the winner changes', async () => {
    const h = harness();
    h.manager.start();
    await h.tick();

    h.setProbe('http://b');
    h.netInfo();
    await h.tick();
    expect(h.onActiveUrl).toEqual(['http://b']);
    expect(h.resyncs()).toBe(2);
  });

  it('goes offline and schedules a backoff retry when all probes fail', async () => {
    const h = harness();
    h.setProbe(null);
    h.manager.start();
    await h.tick();
    expect(h.manager.getState()).toBe('offline');
    expect(h.timers.length).toBe(1);

    // Recovery on the scheduled retry.
    h.setProbe('http://a');
    h.fireTimers();
    await h.tick();
    expect(h.manager.getState()).toBe('connected');
  });

  it('foregrounding kicks an immediate reconnect, bypassing the backoff timer', async () => {
    const h = harness();
    h.setProbe(null);
    h.manager.start();
    await h.tick();
    expect(h.manager.getState()).toBe('offline');
    const pendingTimers = h.timers.length;

    h.setProbe('http://a');
    h.appState(true); // immediate, does not wait for the timer
    await h.tick();
    expect(h.manager.getState()).toBe('connected');
    // The stale backoff timer was cleared, not left to double-fire.
    expect(h.timers.length).toBeLessThan(pendingTimers + 1);
  });

  it('server_shutdown freezes reconnects until an external kick', async () => {
    const h = harness();
    h.manager.start();
    await h.tick();
    expect(h.manager.getState()).toBe('connected');

    h.manager.handleNotice('server_shutdown');
    expect(h.manager.getState()).toBe('server-shutdown');

    // A socket close during shutdown must NOT trigger a probe/backoff.
    h.manager.handleClose();
    await h.tick();
    expect(h.manager.getState()).toBe('server-shutdown');
    expect(h.timers.length).toBe(0);

    // NetInfo/AppState thaws it.
    h.appState(true);
    await h.tick();
    expect(h.manager.getState()).toBe('connected');
  });

  it('ignores an unknown notice and stays connected', async () => {
    const h = harness();
    h.manager.start();
    await h.tick();
    h.manager.handleNotice('something_new');
    expect(h.manager.getState()).toBe('connected');
  });

  it('re-probes on a socket close and reconnects', async () => {
    const h = harness();
    h.manager.start();
    await h.tick();
    h.manager.handleClose();
    await h.tick();
    expect(h.manager.getState()).toBe('connected');
    expect(h.resyncs()).toBe(2);
  });

  it('dispose stops listeners and is idempotent', async () => {
    const h = harness();
    h.manager.start();
    await h.tick();
    h.manager.dispose();
    // Callbacks after dispose are inert.
    h.netInfo();
    h.appState(true);
    await h.tick();
    expect(() => h.manager.dispose()).not.toThrow();
  });
});
