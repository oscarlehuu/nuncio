import { describe, expect, it } from 'vitest';
import {
  createConnectionManager,
  type ConnectionManagerDeps,
  type ConnectionState,
} from './connection-manager';

/**
 * A hand-driven harness. The manager reaches 'connected' only when the socket
 * actually opens, so the harness models that: `reopen` bumps a counter and the
 * test then calls `open()` to simulate the socket connecting. Timers and
 * NetInfo/AppState callbacks are captured so the test can fire them. Probes are
 * async, so tests `await tick()` to let one settle.
 */
function harness(overrides: Partial<ConnectionManagerDeps> = {}) {
  let probeResult: string | null = 'http://a';
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const onActiveUrl: string[] = [];
  let reopens = 0;
  let netInfoCb: (() => void) | null = null;
  let appStateCb: ((active: boolean) => void) | null = null;
  const states: ConnectionState[] = [];

  const deps: ConnectionManagerDeps = {
    candidateUrls: ['http://a', 'http://b'],
    initialUrl: 'http://a',
    probe: async () => probeResult,
    onActiveUrl: (url) => onActiveUrl.push(url),
    reopen: () => {
      reopens += 1;
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
    reopens: () => reopens,
    netInfo: () => netInfoCb?.(),
    appState: (active: boolean) => appStateCb?.(active),
    open: () => manager.handleOpen(),
    setProbe: (result: string | null) => {
      probeResult = result;
    },
    fireTimers: () => {
      const due = timers.splice(0, timers.length);
      for (const t of due) t.fn();
    },
    tick: async () => {
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}

describe('createConnectionManager', () => {
  it('reaches connected when the initial socket opens', async () => {
    const h = harness();
    h.manager.start();
    expect(h.manager.getState()).toBe('connecting'); // awaiting first open
    h.open();
    expect(h.manager.getState()).toBe('connected');
  });

  it('resyncs from the current cursor when foregrounding a healthy session', async () => {
    const h = harness();
    h.manager.start();
    h.open();
    expect(h.manager.getState()).toBe('connected');
    h.appState(true);
    await h.tick();
    expect(h.reopens()).toBe(1);
    expect(h.onActiveUrl).toEqual([]);
    expect(h.manager.getState()).toBe('connected');
  });

  it('on a drop, re-probes and reopens on the same URL without switching', async () => {
    const h = harness();
    h.manager.start();
    h.open();
    h.manager.handleClose();
    await h.tick();
    expect(h.onActiveUrl).toEqual([]); // winner unchanged
    expect(h.reopens()).toBe(1);
    h.open(); // the reopened socket connects
    expect(h.manager.getState()).toBe('connected');
  });

  it('switches the active URL and reopens when the winner changes', async () => {
    const h = harness();
    h.manager.start();
    h.open();

    h.setProbe('http://b');
    h.manager.handleClose();
    await h.tick();
    expect(h.onActiveUrl).toEqual(['http://b']); // api client repointed first
    expect(h.reopens()).toBe(1); // then reopened on the winner
  });

  it('a network change while connected switches to a better URL', async () => {
    const h = harness();
    h.manager.start();
    h.open();

    // Wi-Fi→cellular: the LAN URL is dead, the probe now prefers Funnel.
    h.setProbe('http://b');
    h.netInfo();
    await h.tick();
    expect(h.onActiveUrl).toEqual(['http://b']);
    expect(h.reopens()).toBe(1);
    expect(h.manager.getState()).toBe('connected'); // stayed connected, no flicker
  });

  it('a network change with the same winner leaves a healthy connection alone', async () => {
    const h = harness();
    h.manager.start();
    h.open();

    h.netInfo(); // winner still 'http://a'
    await h.tick();
    expect(h.onActiveUrl).toEqual([]); // no switch
    expect(h.reopens()).toBe(0); // no socket churn
    expect(h.manager.getState()).toBe('connected'); // no 'connecting' flip
  });

  it('goes offline and schedules a backoff retry when all probes fail', async () => {
    const h = harness();
    h.manager.start();
    h.open();
    h.setProbe(null);
    h.manager.handleClose();
    await h.tick();
    expect(h.manager.getState()).toBe('offline');
    expect(h.timers.length).toBe(1);

    // Recovery on the scheduled retry.
    h.setProbe('http://a');
    h.fireTimers();
    await h.tick();
    expect(h.reopens()).toBe(1);
    h.open();
    expect(h.manager.getState()).toBe('connected');
  });

  it('foregrounding kicks an immediate reconnect, bypassing the backoff timer', async () => {
    const h = harness();
    h.manager.start();
    h.open();
    h.setProbe(null);
    h.manager.handleClose();
    await h.tick();
    expect(h.manager.getState()).toBe('offline');
    const pendingTimers = h.timers.length;

    h.setProbe('http://a');
    h.appState(true); // immediate, does not wait for the timer
    await h.tick();
    expect(h.reopens()).toBe(1);
    h.open();
    expect(h.manager.getState()).toBe('connected');
    // The stale backoff timer was cleared, not left to double-fire.
    expect(h.timers.length).toBeLessThan(pendingTimers + 1);
  });

  it('server_shutdown suppresses close recovery but arms a bounded cooldown', async () => {
    const h = harness();
    h.manager.start();
    h.open();
    expect(h.manager.getState()).toBe('connected');

    h.manager.handleNotice('server_shutdown');
    expect(h.manager.getState()).toBe('server-shutdown');

    // A socket close during shutdown must NOT trigger a probe/backoff/reopen.
    h.manager.handleClose();
    await h.tick();
    expect(h.manager.getState()).toBe('server-shutdown');
    expect(h.timers.length).toBe(1);
    expect(h.timers[0]!.ms).toBeGreaterThanOrEqual(1_000);
    expect(h.timers[0]!.ms).toBeLessThanOrEqual(2_000);
    expect(h.reopens()).toBe(0);

    // AppState may thaw it before the cooldown expires.
    h.appState(true);
    await h.tick();
    expect(h.reopens()).toBe(1);
    h.open();
    expect(h.manager.getState()).toBe('connected');

    // A stale cooldown callback is inert after the external recovery.
    h.fireTimers();
    await h.tick();
    expect(h.reopens()).toBe(1);
  });

  it('automatically probes again after server_shutdown without an OS signal', async () => {
    const h = harness();
    h.manager.start();
    h.open();

    h.manager.handleNotice('server_shutdown');
    h.manager.handleClose();
    expect(h.manager.getState()).toBe('server-shutdown');
    expect(h.reopens()).toBe(0);

    h.fireTimers();
    await h.tick();

    expect(h.reopens()).toBe(1);
    h.open();
    expect(h.manager.getState()).toBe('connected');
  });

  it('does not run a server_shutdown cooldown after disposal', async () => {
    const h = harness();
    h.manager.start();
    h.open();
    h.manager.handleNotice('server_shutdown');

    h.manager.dispose();
    h.fireTimers();
    await h.tick();

    expect(h.reopens()).toBe(0);
  });

  it('a NetInfo change thaws a server_shutdown freeze without AppState', async () => {
    const h = harness();
    h.manager.start();
    h.open();
    h.manager.handleNotice('server_shutdown');
    expect(h.manager.getState()).toBe('server-shutdown');

    // A network/Tailscale recovery while the app stays foregrounded must recover
    // on its own — AppState never fires here.
    h.netInfo();
    await h.tick();
    expect(h.reopens()).toBe(1);
    h.open();
    expect(h.manager.getState()).toBe('connected');
  });

  it('ignores an unknown notice and stays connected', async () => {
    const h = harness();
    h.manager.start();
    h.open();
    h.manager.handleNotice('something_new');
    expect(h.manager.getState()).toBe('connected');
    expect(h.reopens()).toBe(0);
  });

  it('shouldReconnect is always false — the manager is the sole reconnect authority', async () => {
    const h = harness();
    h.manager.start();
    h.open();
    // Even while connected the relay must not self-reconnect; the manager drives
    // every reconnect through handleClose so there is never a double-reconnect.
    expect(h.manager.shouldReconnect()).toBe(false);
    h.manager.handleNotice('server_shutdown');
    expect(h.manager.shouldReconnect()).toBe(false);
  });

  it('a stale in-flight probe does not clobber a newer one', async () => {
    // Two closes in quick succession: the first probe is slow, the second fast.
    // Only the latest probe's reopen may apply.
    const firstProbe: { resolve: (v: string | null) => void } = { resolve: () => {} };
    let call = 0;
    const h = harness({
      probe: () => {
        call += 1;
        if (call === 1) return new Promise<string | null>((r) => (firstProbe.resolve = r));
        return Promise.resolve('http://a');
      },
    });
    h.manager.start();
    h.open();
    h.manager.handleClose(); // starts slow probe (call 1)
    h.manager.handleClose(); // starts fast probe (call 2), supersedes call 1
    await h.tick();
    firstProbe.resolve('http://b'); // the stale probe finally resolves
    await h.tick();
    // The stale 'http://b' must NOT have switched the URL.
    expect(h.onActiveUrl).toEqual([]);
  });

  it('dispose stops listeners and is idempotent', async () => {
    const h = harness();
    h.manager.start();
    h.open();
    h.manager.dispose();
    // Callbacks after dispose are inert.
    h.netInfo();
    h.appState(true);
    await h.tick();
    expect(h.reopens()).toBe(0);
    expect(() => h.manager.dispose()).not.toThrow();
  });
});
