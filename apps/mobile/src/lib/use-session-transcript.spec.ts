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
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
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
});
