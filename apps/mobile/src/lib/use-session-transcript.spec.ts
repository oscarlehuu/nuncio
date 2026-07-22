// @vitest-environment jsdom

import { act, createElement } from 'react';
// @ts-expect-error Mobile ships react-dom for Expo web, but omits its browser-only type package.
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSessionTranscript } from './use-session-transcript';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => {
  const subscription = {
    call: vi.fn(),
    close: vi.fn(),
    resync: vi.fn(),
  };
  const manager = {
    dispose: vi.fn(),
    getState: vi.fn(() => 'connecting'),
    handleClose: vi.fn(),
    handleNotice: vi.fn(),
    handleOpen: vi.fn(),
    shouldReconnect: vi.fn(() => false),
    start: vi.fn(),
    subscribe: vi.fn(() => vi.fn()),
  };
  return {
    activeConnection: vi.fn(() => ({
      serverUrl: 'http://phone-host',
      candidateUrls: ['http://phone-host'],
      token: 'secret',
    })),
    applyConnection: vi.fn(),
    authHeader: vi.fn(() => ({ Authorization: 'Bearer secret' })),
    createNativeConnectionManager: vi.fn(() => manager),
    fetchEvents: vi.fn(),
    manager,
    relayUrlFor: vi.fn(() => 'ws://phone-host/api/sessions/ws'),
    subscribeSessionEvents: vi.fn(() => subscription),
    subscription,
  };
});

vi.mock('@nuncio/core/api', () => ({ fetchEvents: mocks.fetchEvents }));
vi.mock('@nuncio/core/session-relay-client', () => ({
  subscribeSessionEvents: mocks.subscribeSessionEvents,
}));
vi.mock('./api-setup', () => ({
  activeConnection: mocks.activeConnection,
  applyConnection: mocks.applyConnection,
}));
vi.mock('./connection-store', () => ({
  authHeader: mocks.authHeader,
  relayUrlFor: mocks.relayUrlFor,
}));
vi.mock('./connection-manager-native', () => ({
  createNativeConnectionManager: mocks.createNativeConnectionManager,
}));

type TranscriptHook = ReturnType<typeof useSessionTranscript>;
type TestRoot = {
  render: (children: ReturnType<typeof createElement>) => void;
  unmount: () => void;
};

function event(seq: number) {
  return { seq, type: 'status', payload: {}, createdAt: seq };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flushEffects() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('useSessionTranscript', () => {
  let container: HTMLDivElement;
  let root: TestRoot;
  let latest: TranscriptHook | undefined;

  function Harness({ sessionId }: { sessionId: string | null }) {
    latest = useSessionTranscript(sessionId);
    return null;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.activeConnection.mockReturnValue({
      serverUrl: 'http://phone-host',
      candidateUrls: ['http://phone-host'],
      token: 'secret',
    });
    mocks.fetchEvents.mockReset();
    mocks.subscribeSessionEvents.mockReturnValue(mocks.subscription);
    mocks.createNativeConnectionManager.mockReturnValue(mocks.manager);
    mocks.manager.subscribe.mockReturnValue(vi.fn());
    latest = undefined;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container) as TestRoot;
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('starts the relay from seq 0 when REST bootstrap fails', async () => {
    mocks.fetchEvents.mockRejectedValueOnce(new Error('temporary REST failure'));

    await act(async () => {
      root.render(createElement(Harness, { sessionId: 's1' }));
    });
    await flushEffects();

    expect(mocks.createNativeConnectionManager).toHaveBeenCalledOnce();
    expect(mocks.subscribeSessionEvents).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 's1', since: 0 }),
    );
    expect(mocks.manager.start).toHaveBeenCalledOnce();
  });

  it('starts the relay from seq 0 when REST bootstrap stays pending', async () => {
    vi.useFakeTimers();
    mocks.fetchEvents.mockReturnValueOnce(new Promise(() => {}));
    await act(async () => {
      root.render(createElement(Harness, { sessionId: 's1' }));
    });

    expect(mocks.subscribeSessionEvents).not.toHaveBeenCalled();
    await act(async () => {
      vi.advanceTimersByTime(1_000);
      await Promise.resolve();
    });

    expect(mocks.subscribeSessionEvents).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 's1', since: 0 }),
    );
  });

  it('reopens from the highest live seq before the batched UI flush', async () => {
    mocks.fetchEvents.mockResolvedValueOnce([event(1)]);
    await act(async () => {
      root.render(createElement(Harness, { sessionId: 's1' }));
    });
    await flushEffects();
    const relayCalls = mocks.subscribeSessionEvents.mock.calls as unknown as Array<[
      { onEvent: (item: ReturnType<typeof event>) => void },
    ]>;
    const managerCalls = mocks.createNativeConnectionManager.mock.calls as unknown as Array<[
      { reopen: () => void },
    ]>;
    const firstOptions = relayCalls[0]![0];
    const managerOptions = managerCalls[0]![0];

    act(() => firstOptions.onEvent(event(7)));
    act(() => managerOptions.reopen());

    expect(mocks.subscribeSessionEvents).toHaveBeenLastCalledWith(
      expect.objectContaining({ sessionId: 's1', since: 7 }),
    );
  });

  it('clears the previous transcript while a different session bootstraps', async () => {
    const sessionB = deferred<ReturnType<typeof event>[]>();
    mocks.fetchEvents.mockImplementation((sessionId: string) => (
      sessionId === 's1' ? Promise.resolve([event(1)]) : sessionB.promise
    ));
    await act(async () => {
      root.render(createElement(Harness, { sessionId: 's1' }));
    });
    await flushEffects();
    expect(latest?.events.map((item) => item.seq)).toEqual([1]);

    await act(async () => {
      root.render(createElement(Harness, { sessionId: 's2' }));
    });

    expect(latest?.events).toEqual([]);
    sessionB.resolve([event(9)]);
    await flushEffects();
    expect(latest?.events.map((item) => item.seq)).toEqual([9]);
  });

  it('ignores a stale session A bootstrap that resolves after session B', async () => {
    const sessionA = deferred<ReturnType<typeof event>[]>();
    mocks.fetchEvents.mockImplementation((sessionId: string) => (
      sessionId === 's1' ? sessionA.promise : Promise.resolve([event(9)])
    ));
    await act(async () => {
      root.render(createElement(Harness, { sessionId: 's1' }));
    });
    await act(async () => {
      root.render(createElement(Harness, { sessionId: 's2' }));
    });
    await flushEffects();
    expect(latest?.events.map((item) => item.seq)).toEqual([9]);

    sessionA.resolve([event(99)]);
    await flushEffects();

    expect(latest?.events.map((item) => item.seq)).toEqual([9]);
    expect(mocks.createNativeConnectionManager).toHaveBeenCalledOnce();
    expect(mocks.subscribeSessionEvents).toHaveBeenCalledOnce();
  });

  it('rolls back manager resources when relay setup throws', async () => {
    const unsubscribe = vi.fn();
    mocks.fetchEvents.mockResolvedValueOnce([]);
    mocks.manager.subscribe.mockReturnValueOnce(unsubscribe);
    mocks.subscribeSessionEvents.mockImplementationOnce(() => {
      throw new Error('WebSocket constructor failed');
    });

    await act(async () => {
      root.render(createElement(Harness, { sessionId: 's1' }));
    });
    await flushEffects();

    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(mocks.manager.dispose).toHaveBeenCalledOnce();
  });

  it('bootstraps and subscribes with a finite tail while exposing earlier history', async () => {
    mocks.fetchEvents.mockResolvedValueOnce([event(900), event(901)]);

    await act(async () => {
      root.render(createElement(Harness, { sessionId: 's1' }));
    });
    await flushEffects();

    expect(mocks.fetchEvents).toHaveBeenCalledWith('s1', 0, '', { tail: 1_000 });
    expect(mocks.subscribeSessionEvents).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 's1', since: 901, tail: 1_000 }),
    );
    expect(latest?.events.map((item) => item.seq)).toEqual([900, 901]);
    expect(latest?.hasEarlier).toBe(true);
  });

  it('clears events and disables paging when the session becomes null', async () => {
    mocks.fetchEvents.mockResolvedValueOnce([event(5)]);

    await act(async () => {
      root.render(createElement(Harness, { sessionId: 's1' }));
    });
    await flushEffects();
    expect(latest?.hasEarlier).toBe(true);

    await act(async () => {
      root.render(createElement(Harness, { sessionId: null }));
    });

    expect(latest?.events).toEqual([]);
    expect(latest?.hasEarlier).toBe(false);
    await act(async () => {
      await latest!.loadEarlier();
    });
    expect(mocks.fetchEvents).toHaveBeenCalledOnce();
  });

  it('pages before the oldest event, retains concurrent live events, and stops at seq 1', async () => {
    vi.useFakeTimers();
    const earlier = deferred<ReturnType<typeof event>[]>();
    mocks.fetchEvents
      .mockResolvedValueOnce([event(5), event(6)])
      .mockReturnValueOnce(earlier.promise);

    await act(async () => {
      root.render(createElement(Harness, { sessionId: 's1' }));
    });
    await flushEffects();
    const relayCalls = mocks.subscribeSessionEvents.mock.calls as unknown as Array<[
      { onEvent: (item: ReturnType<typeof event>) => void },
    ]>;

    let loadPromise!: Promise<void>;
    act(() => {
      loadPromise = latest!.loadEarlier();
      relayCalls[0]![0].onEvent(event(7));
    });
    expect(mocks.fetchEvents).toHaveBeenLastCalledWith('s1', 0, '', { before: 5 });

    earlier.resolve([event(1), event(2), event(3), event(4), event(5)]);
    await act(async () => {
      await loadPromise;
      vi.advanceTimersByTime(16);
      await Promise.resolve();
    });

    expect(latest?.events.map((item) => item.seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(latest?.hasEarlier).toBe(false);

    await act(async () => {
      await latest!.loadEarlier();
    });
    expect(mocks.fetchEvents).toHaveBeenCalledTimes(2);
  });

  it('single-flights earlier-page requests and releases the guard after failure', async () => {
    const failed = deferred<ReturnType<typeof event>[]>();
    mocks.fetchEvents
      .mockResolvedValueOnce([event(5)])
      .mockReturnValueOnce(failed.promise)
      .mockResolvedValueOnce([event(1), event(2), event(3), event(4)]);

    await act(async () => {
      root.render(createElement(Harness, { sessionId: 's1' }));
    });
    await flushEffects();

    let first!: Promise<void>;
    let second!: Promise<void>;
    act(() => {
      first = latest!.loadEarlier();
      second = latest!.loadEarlier();
    });
    expect(mocks.fetchEvents).toHaveBeenCalledTimes(2);

    const firstRejected = expect(first).rejects.toThrow('page failed');
    const secondRejected = expect(second).rejects.toThrow('page failed');
    failed.reject(new Error('page failed'));
    await Promise.all([firstRejected, secondRejected]);

    await act(async () => {
      await latest!.loadEarlier();
    });
    expect(mocks.fetchEvents).toHaveBeenCalledTimes(3);
    expect(latest?.events.map((item) => item.seq)).toEqual([1, 2, 3, 4, 5]);
  });

  it('ignores an earlier page that resolves after the session changes', async () => {
    const sessionAEarlier = deferred<ReturnType<typeof event>[]>();
    mocks.fetchEvents.mockImplementation((sessionId: string, _since: number, _base: string, window?: { before?: number }) => {
      if (sessionId === 's1' && window?.before === 5) return sessionAEarlier.promise;
      return Promise.resolve(sessionId === 's1' ? [event(5)] : [event(20)]);
    });

    await act(async () => {
      root.render(createElement(Harness, { sessionId: 's1' }));
    });
    await flushEffects();
    const staleLoad = latest!.loadEarlier();

    await act(async () => {
      root.render(createElement(Harness, { sessionId: 's2' }));
    });
    await flushEffects();
    sessionAEarlier.resolve([event(1), event(2), event(3), event(4)]);
    await act(async () => {
      await staleLoad;
    });

    expect(latest?.events.map((item) => item.seq)).toEqual([20]);
  });

  it('suppresses an earlier-page failure after the session changes', async () => {
    const sessionAEarlier = deferred<ReturnType<typeof event>[]>();
    mocks.fetchEvents.mockImplementation((sessionId: string, _since: number, _base: string, window?: { before?: number }) => {
      if (sessionId === 's1' && window?.before === 5) return sessionAEarlier.promise;
      return Promise.resolve(sessionId === 's1' ? [event(5)] : [event(20)]);
    });

    await act(async () => {
      root.render(createElement(Harness, { sessionId: 's1' }));
    });
    await flushEffects();
    const staleLoad = latest!.loadEarlier();

    await act(async () => {
      root.render(createElement(Harness, { sessionId: 's2' }));
    });
    await flushEffects();
    sessionAEarlier.reject(new Error('stale page failed'));

    await expect(staleLoad).resolves.toBeUndefined();
    expect(latest?.events.map((item) => item.seq)).toEqual([20]);
  });

  it('bounds a 10,000-event live burst, protects loaded history, and fills retained gaps', async () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    }));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    mocks.fetchEvents
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(Array.from({ length: 200 }, (_, index) => event(8_801 + index)))
      .mockResolvedValueOnce([event(10_001)]);

    await act(async () => {
      root.render(createElement(Harness, { sessionId: 's1' }));
    });
    await flushEffects();
    const relayCalls = mocks.subscribeSessionEvents.mock.calls as unknown as Array<[
      { onEvent: (item: ReturnType<typeof event>) => void },
    ]>;

    act(() => {
      for (let seq = 1; seq <= 10_000; seq += 1) {
        relayCalls[0]![0].onEvent(event(seq));
      }
    });
    expect(frames).toHaveLength(1);

    const sortSpy = vi.spyOn(Array.prototype, 'sort');
    try {
      act(() => frames.shift()?.(16));
      expect(sortSpy).not.toHaveBeenCalled();
    } finally {
      sortSpy.mockRestore();
    }
    expect(latest?.events).toHaveLength(1_000);
    expect(latest?.events[0]?.seq).toBe(9_001);
    expect(latest?.events.at(-1)?.seq).toBe(10_000);
    expect(latest?.hasEarlier).toBe(true);

    const managerCalls = mocks.createNativeConnectionManager.mock.calls as unknown as Array<[
      { reopen: () => void },
    ]>;
    act(() => managerCalls[0]![0].reopen());
    expect(mocks.subscribeSessionEvents).toHaveBeenLastCalledWith(
      expect.objectContaining({ sessionId: 's1', since: 10_000, tail: 1_000 }),
    );

    await act(async () => {
      await latest!.loadEarlier();
    });
    expect(mocks.fetchEvents).toHaveBeenLastCalledWith('s1', 0, '', { before: 9_001 });
    expect(latest?.events).toHaveLength(1_200);
    expect(latest?.events[0]?.seq).toBe(8_801);

    const latestRelay = (mocks.subscribeSessionEvents.mock.calls as unknown as Array<[
      { onEvent: (item: ReturnType<typeof event>) => void },
    ]>).at(-1)![0];
    act(() => {
      for (let seq = 10_001; seq <= 11_001; seq += 1) {
        latestRelay.onEvent(event(seq));
      }
    });
    act(() => frames.shift()?.(32));

    expect(latest?.events).toHaveLength(2_200);
    expect(latest?.events[0]?.seq).toBe(8_801);
    expect(latest?.events.some((item) => item.seq === 10_001)).toBe(false);
    expect(latest?.events.at(-1)?.seq).toBe(11_001);

    await act(async () => {
      await latest!.loadEarlier();
    });
    expect(mocks.fetchEvents).toHaveBeenLastCalledWith('s1', 0, '', { before: 10_002 });
    expect(latest?.events.some((item) => item.seq === 10_001)).toBe(true);
  });
});
