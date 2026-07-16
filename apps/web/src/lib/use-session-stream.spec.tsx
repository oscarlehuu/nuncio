import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, waitFor, act } from '@testing-library/react';
import { sessionRelayUrl, useSessionStream } from './use-session-stream';
import { resetBrowserSessionRelayPoolForTests } from '@nuncio/core/session-relay-pool';

vi.mock('./api', () => ({ fetchEvents: vi.fn() }));

import { fetchEvents } from './api';

type Listener = (event: { data?: unknown }) => void;

class MockWebSocket {
  static instances: MockWebSocket[] = [];
  url: string;
  sent: Array<Record<string, unknown>> = [];
  closed = false;
  private listeners = new Map<string, Listener[]>();

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
    lastSocket = this;
    queueMicrotask(() => this.fire('open', {}));
  }

  addEventListener(type: string, listener: Listener): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
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

  drop(): void {
    this.fire('close', {});
  }

  push(event: unknown): void {
    this.fire('message', { data: JSON.stringify({ channel: 's1', event }) });
  }

  pushTo(channel: string, event: unknown): void {
    this.fire('message', { data: JSON.stringify({ channel, event }) });
  }

  get subscribes(): Array<Record<string, unknown>> {
    return this.sent.filter((m) => m.method === 'subscribe');
  }
}

let lastSocket: MockWebSocket | undefined;

function ev(seq: number, type = 'status', payload: Record<string, unknown> = {}) {
  return { seq, type, payload, createdAt: 0 };
}

function subscribeSince(socket: MockWebSocket): number {
  const last = socket.subscribes[socket.subscribes.length - 1];
  return (last?.params as { since: number }).since;
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

function Harness({
  sid,
  tail,
  onReady,
}: {
  sid: string | null;
  tail?: number;
  onReady?: (api: ReturnType<typeof useSessionStream>) => void;
}) {
  const stream = useSessionStream(sid, '', tail);
  onReady?.(stream);
  return <div data-testid="count">{stream.events.length}</div>;
}

function StreamCount({ sid, base = '', testId }: { sid: string; base?: string; testId: string }) {
  const stream = useSessionStream(sid, base);
  return <div data-testid={testId}>{stream.events.length}</div>;
}

describe('sessionRelayUrl', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('maps http origins to ws', () => {
    vi.stubGlobal('window', {
      location: { origin: 'http://localhost:5173' },
    });
    expect(sessionRelayUrl()).toBe('ws://localhost:5173/api/sessions/ws');
  });

  it('maps https origins to wss and prefixes hub bases', () => {
    vi.stubGlobal('window', {
      location: { origin: 'https://hub.ts.net' },
    });
    expect(sessionRelayUrl('/m/oscar-workstation')).toBe(
      'wss://hub.ts.net/m/oscar-workstation/api/sessions/ws',
    );
  });
});

describe('useSessionStream', () => {
  beforeEach(() => {
    resetBrowserSessionRelayPoolForTests();
    vi.stubGlobal('WebSocket', MockWebSocket);
    vi.mocked(fetchEvents).mockReset();
    lastSocket = undefined;
    MockWebSocket.instances.length = 0;
  });
  afterEach(() => {
    resetBrowserSessionRelayPoolForTests();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('multiplexes two same-machine hooks over one relay socket', async () => {
    vi.mocked(fetchEvents).mockImplementation((id) => Promise.resolve([ev(id === 's1' ? 1 : 10)]));
    const view = render(
      <>
        <StreamCount sid="s1" testId="first-count" />
        <StreamCount sid="s2" testId="second-count" />
      </>,
    );

    await waitFor(() => expect(view.getByTestId('first-count').textContent).toBe('1'));
    await waitFor(() => expect(view.getByTestId('second-count').textContent).toBe('1'));
    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    const socket = MockWebSocket.instances[0]!;
    await waitFor(() => expect(socket.subscribes).toHaveLength(2));

    act(() => socket.pushTo('s1', ev(2, 'assistant_delta', { delta: 'a' })));
    await waitFor(() => expect(view.getByTestId('first-count').textContent).toBe('2'));
    expect(view.getByTestId('second-count').textContent).toBe('1');

    act(() => socket.pushTo('s2', ev(11, 'assistant_delta', { delta: 'b' })));
    await waitFor(() => expect(view.getByTestId('second-count').textContent).toBe('2'));
    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it('keeps different hub-machine bases on separate relay sockets', async () => {
    vi.mocked(fetchEvents).mockResolvedValue([ev(1)]);
    render(
      <>
        <StreamCount sid="s1" base="/m/mac-a" testId="first-count" />
        <StreamCount sid="s2" base="/m/mac-b" testId="second-count" />
      </>,
    );

    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(2));
    expect(MockWebSocket.instances.map((socket) => socket.url).sort()).toEqual([
      'ws://localhost/m/mac-a/api/sessions/ws',
      'ws://localhost/m/mac-b/api/sessions/ws',
    ]);
  });

  it('seeds events from fetchEvents on mount', async () => {
    vi.mocked(fetchEvents).mockResolvedValue([ev(1), ev(2)]);
    const { getByTestId } = render(<Harness sid="s1" />);
    await waitFor(() => expect(getByTestId('count').textContent).toBe('2'));
    expect(fetchEvents).toHaveBeenCalledWith('s1', 0, '');
  });

  it('appends events delivered over the relay socket', async () => {
    vi.mocked(fetchEvents).mockResolvedValue([ev(1)]);
    const { getByTestId } = render(<Harness sid="s1" />);
    await waitFor(() => expect(getByTestId('count').textContent).toBe('1'));
    await waitFor(() => expect(lastSocket).toBeDefined());

    act(() => lastSocket!.push(ev(2, 'assistant_message', { text: 'hi' })));
    await waitFor(() => expect(getByTestId('count').textContent).toBe('2'));
  });

  it('deduplicates events by seq', async () => {
    vi.mocked(fetchEvents).mockResolvedValue([ev(1)]);
    const { getByTestId } = render(<Harness sid="s1" />);
    await waitFor(() => expect(getByTestId('count').textContent).toBe('1'));
    await waitFor(() => expect(lastSocket).toBeDefined());

    act(() => lastSocket!.push(ev(1)));
    expect(getByTestId('count').textContent).toBe('1');
  });

  it('batches a live event burst into one animation-frame state flush', async () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((callback: FrameRequestCallback) => {
        frames.push(callback);
        return frames.length;
      }),
    );
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    vi.mocked(fetchEvents).mockResolvedValue([ev(1)]);
    const { getByTestId } = render(<Harness sid="s1" />);
    await waitFor(() => expect(getByTestId('count').textContent).toBe('1'));
    await waitFor(() => expect(lastSocket).toBeDefined());

    act(() => {
      lastSocket!.push(ev(2, 'assistant_delta', { delta: 'a' }));
      lastSocket!.push(ev(3, 'assistant_delta', { delta: 'b' }));
      lastSocket!.push(ev(4, 'assistant_delta', { delta: 'c' }));
    });

    expect(getByTestId('count').textContent).toBe('1');
    expect(frames.length).toBe(1);

    act(() => frames.shift()?.(16));
    await waitFor(() => expect(getByTestId('count').textContent).toBe('4'));
  });

  it('merges a live burst through the setTimeout fallback when requestAnimationFrame is unavailable', async () => {
    // Environments without RAF (or when it is stripped) must still batch and
    // deliver every event via the setTimeout(16) fallback — no event dropped.
    const originalRaf = globalThis.requestAnimationFrame;
    // Force the fallback branch: scheduleEventFlush checks `typeof rAF === 'function'`.
    vi.stubGlobal('requestAnimationFrame', undefined);
    vi.useFakeTimers();
    try {
      vi.mocked(fetchEvents).mockResolvedValue([ev(1)]);
      let api: ReturnType<typeof useSessionStream> | undefined;
      render(<Harness sid="s1" onReady={(stream) => { api = stream; }} />);

      // Drain the fetch microtask + queueMicrotask open under fake timers.
      await act(async () => {
        await vi.runOnlyPendingTimersAsync();
      });
      await act(async () => {
        await Promise.resolve();
      });
      expect(lastSocket).toBeDefined();

      act(() => {
        lastSocket!.push(ev(2, 'assistant_delta', { delta: 'a' }));
        lastSocket!.push(ev(3, 'assistant_delta', { delta: 'b' }));
        lastSocket!.push(ev(4, 'assistant_delta', { delta: 'c' }));
      });
      // Not flushed yet — still coalesced behind the pending setTimeout.
      expect(api!.events.map((e) => e.seq)).toEqual([1]);

      act(() => {
        vi.advanceTimersByTime(16);
      });
      expect(api!.events.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    } finally {
      vi.useRealTimers();
      vi.stubGlobal('requestAnimationFrame', originalRaf);
    }
  });

  it('cancels the pending flush on unmount without a post-unmount state update', async () => {
    // A flush scheduled just before unmount must be cancelled, and no state
    // update may run afterward — otherwise React logs an act()/unmounted-update
    // warning and, worse, touches torn-down refs.
    const frames: FrameRequestCallback[] = [];
    const cancel = vi.fn();
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((callback: FrameRequestCallback) => {
        frames.push(callback);
        return frames.length;
      }),
    );
    vi.stubGlobal('cancelAnimationFrame', cancel);
    vi.mocked(fetchEvents).mockResolvedValue([ev(1)]);

    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { getByTestId, unmount } = render(<Harness sid="s1" />);
    await waitFor(() => expect(getByTestId('count').textContent).toBe('1'));
    await waitFor(() => expect(lastSocket).toBeDefined());

    // Schedule a flush, then unmount before the frame callback runs.
    act(() => {
      lastSocket!.push(ev(2, 'assistant_delta', { delta: 'x' }));
    });
    expect(frames.length).toBe(1);

    unmount();
    expect(cancel).toHaveBeenCalled();

    // Fire the (now-stale) frame callback: it must be a no-op, no warning.
    act(() => frames.shift()?.(16));
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('cancels the pending rAF flush with the window receiver (no Illegal invocation on unmount)', async () => {
    // Real browsers brand-check cancelAnimationFrame: invoking it with a receiver
    // that is not the global throws "TypeError: Illegal invocation". A cancel
    // callback that forwards through the window receiver survives; a bare
    // reference stored on the ScheduledFlush object and called as
    // `scheduled.cancel(id)` would run with `this` bound to that object and crash
    // the app to a blank screen on unmount. Stub the real receiver check here —
    // a plain vi.fn() (as elsewhere) ignores `this` and cannot catch this.
    const frames: FrameRequestCallback[] = [];
    const cancelCalls: boolean[] = [];
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((callback: FrameRequestCallback) => {
        frames.push(callback);
        return frames.length;
      }),
    );
    vi.stubGlobal(
      'cancelAnimationFrame',
      vi.fn(function (this: unknown) {
        if (this !== globalThis && this !== window) {
          throw new TypeError('Illegal invocation');
        }
        cancelCalls.push(true);
      }),
    );
    vi.mocked(fetchEvents).mockResolvedValue([ev(1)]);

    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { getByTestId, unmount } = render(<Harness sid="s1" />);
    await waitFor(() => expect(getByTestId('count').textContent).toBe('1'));
    await waitFor(() => expect(lastSocket).toBeDefined());

    // Schedule a flush (pending rAF), then unmount before the frame fires so the
    // teardown path cancels it.
    act(() => {
      lastSocket!.push(ev(2, 'assistant_delta', { delta: 'x' }));
    });
    expect(frames.length).toBe(1);

    expect(() => unmount()).not.toThrow();
    // Cancel ran exactly once and with a valid (global) receiver — the bare
    // reference would have thrown before recording anything.
    expect(cancelCalls).toEqual([true]);
    warn.mockRestore();
  });

  it('clears events and skips fetch when the session id is null', async () => {
    vi.mocked(fetchEvents).mockResolvedValue([ev(1)]);
    const { getByTestId } = render(<Harness sid={null} />);
    await waitFor(() => expect(getByTestId('count').textContent).toBe('0'));
    expect(fetchEvents).not.toHaveBeenCalled();
    expect(lastSocket).toBeUndefined();
  });

  it('clears the previous transcript while a different session bootstraps', async () => {
    const sessionB = deferred<ReturnType<typeof ev>[]>();
    vi.mocked(fetchEvents).mockImplementation((id) => {
      if (id === 's1') return Promise.resolve([ev(1)]);
      return sessionB.promise;
    });
    let api: ReturnType<typeof useSessionStream> | undefined;
    const view = render(
      <Harness sid="s1" onReady={(stream) => { api = stream; }} />,
    );
    await waitFor(() => expect(api?.events.map((event) => event.seq)).toEqual([1]));

    view.rerender(<Harness sid="s2" onReady={(stream) => { api = stream; }} />);

    await waitFor(() => expect(api?.events).toEqual([]));
    expect(fetchEvents).toHaveBeenLastCalledWith('s2', 0, '');

    sessionB.resolve([ev(8)]);
    await waitFor(() => expect(api?.events.map((event) => event.seq)).toEqual([8]));
  });

  it('requests only the tail window on mount when a tail depth is set', async () => {
    vi.mocked(fetchEvents).mockResolvedValue([ev(5), ev(6)]);
    render(<Harness sid="s1" tail={50} />);
    await waitFor(() => expect(fetchEvents).toHaveBeenCalledWith('s1', 0, '', { tail: 50 }));
    await waitFor(() => expect(lastSocket).toBeDefined());
    await waitFor(() => expect(subscribeSince(lastSocket!)).toBe(6));
  });

  it('loadEarlier prepends the previous page and reports exhausted history', async () => {
    vi.mocked(fetchEvents)
      .mockResolvedValueOnce([ev(5), ev(6)])
      .mockResolvedValueOnce([ev(3), ev(4)])
      .mockResolvedValueOnce([ev(1), ev(2)]);
    let api: ReturnType<typeof useSessionStream> | undefined;
    const { getByTestId } = render(
      <Harness sid="s1" tail={2} onReady={(stream) => { api = stream; }} />,
    );
    await waitFor(() => expect(getByTestId('count').textContent).toBe('2'));
    expect(api!.hasEarlier).toBe(true);

    await act(async () => {
      await api!.loadEarlier();
    });
    expect(fetchEvents).toHaveBeenLastCalledWith('s1', 0, '', { before: 5 });
    await waitFor(() => expect(api!.events.map((e) => e.seq)).toEqual([3, 4, 5, 6]));
    expect(api!.hasEarlier).toBe(true);

    await act(async () => {
      await api!.loadEarlier();
    });
    await waitFor(() => expect(api!.events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6]));
    expect(api!.hasEarlier).toBe(false);
  });

  it('hasEarlier is false when the full history is already loaded', async () => {
    vi.mocked(fetchEvents).mockResolvedValue([ev(1), ev(2)]);
    let api: ReturnType<typeof useSessionStream> | undefined;
    const { getByTestId } = render(
      <Harness sid="s1" onReady={(stream) => { api = stream; }} />,
    );
    await waitFor(() => expect(getByTestId('count').textContent).toBe('2'));
    expect(api!.hasEarlier).toBe(false);
  });

  it('opens the relay socket and subscribes with the since cursor', async () => {
    vi.mocked(fetchEvents).mockResolvedValue([ev(1), ev(5)]);
    render(<Harness sid="s1" />);
    await waitFor(() => expect(lastSocket).toBeDefined());
    expect(lastSocket!.url).toBe('ws://localhost/api/sessions/ws');
    await waitFor(() => expect(lastSocket!.subscribes.length).toBe(1));
    expect(lastSocket!.subscribes[0].params).toMatchObject({ sessionId: 's1', since: 5 });
  });

  it('refetch re-loads events from the server and resubscribes', async () => {
    vi.mocked(fetchEvents)
      .mockResolvedValueOnce([ev(1)])
      .mockResolvedValueOnce([ev(1), ev(2, 'user_message', { text: 'synced' })]);
    let api: ReturnType<typeof useSessionStream> | undefined;
    const { getByTestId } = render(
      <Harness sid="s1" onReady={(stream) => { api = stream; }} />,
    );
    await waitFor(() => expect(getByTestId('count').textContent).toBe('1'));
    await waitFor(() => expect(api).toBeDefined());

    await act(async () => {
      await api!.refetch();
    });

    await waitFor(() => expect(getByTestId('count').textContent).toBe('2'));
    expect(fetchEvents).toHaveBeenLastCalledWith('s1', 0, '');
    expect(MockWebSocket.instances).toHaveLength(1);
    await waitFor(() => expect(subscribeSince(MockWebSocket.instances[0]!)).toBe(2));
  });

  it('does not let a stale refetch from session A overwrite session B or seed its cursor', async () => {
    const staleARefetch = deferred<ReturnType<typeof ev>[]>();
    let sessionAFetches = 0;
    vi.mocked(fetchEvents).mockImplementation((id) => {
      if (id === 's1') {
        sessionAFetches += 1;
        return sessionAFetches === 1 ? Promise.resolve([ev(1)]) : staleARefetch.promise;
      }
      return Promise.resolve([ev(10)]);
    });
    let api: ReturnType<typeof useSessionStream> | undefined;
    const view = render(
      <Harness sid="s1" onReady={(stream) => { api = stream; }} />,
    );
    await waitFor(() => expect(api?.events.map((event) => event.seq)).toEqual([1]));

    let staleRefetch!: Promise<void>;
    act(() => {
      staleRefetch = api!.refetch();
    });
    await waitFor(() => expect(sessionAFetches).toBe(2));
    view.rerender(<Harness sid="s2" onReady={(stream) => { api = stream; }} />);
    await waitFor(() => expect(api?.events.map((event) => event.seq)).toEqual([10]));
    const bSocket = MockWebSocket.instances[MockWebSocket.instances.length - 1]!;
    await waitFor(() => expect(bSocket.subscribes.at(-1)?.params).toMatchObject({ sessionId: 's2', since: 10 }));

    staleARefetch.resolve([ev(99)]);
    await act(async () => {
      await staleRefetch;
    });

    expect(api!.events.map((event) => event.seq)).toEqual([10]);
    expect(MockWebSocket.instances[MockWebSocket.instances.length - 1]).toBe(bSocket);
    expect(bSocket.subscribes.filter((message) => (
      message.params as { sessionId: string }
    ).sessionId === 's2')).toHaveLength(1);
  });

  it('does not let an older same-session refetch overwrite a newer result', async () => {
    const older = deferred<ReturnType<typeof ev>[]>();
    const newer = deferred<ReturnType<typeof ev>[]>();
    let fetchCount = 0;
    vi.mocked(fetchEvents).mockImplementation(() => {
      fetchCount += 1;
      if (fetchCount === 1) return Promise.resolve([ev(1)]);
      return fetchCount === 2 ? older.promise : newer.promise;
    });
    let api: ReturnType<typeof useSessionStream> | undefined;
    render(<Harness sid="s1" onReady={(stream) => { api = stream; }} />);
    await waitFor(() => expect(api?.events.map((event) => event.seq)).toEqual([1]));

    const olderRequest = api!.refetch();
    const newerRequest = api!.refetch();
    newer.resolve([ev(12)]);
    await act(async () => {
      await newerRequest;
    });
    expect(api!.events.map((event) => event.seq)).toEqual([1, 12]);
    const newestSocket = MockWebSocket.instances[MockWebSocket.instances.length - 1]!;
    await waitFor(() => expect(subscribeSince(newestSocket)).toBe(12));
    expect(subscribeSince(newestSocket)).toBe(12);

    older.resolve([ev(4)]);
    await act(async () => {
      await olderRequest;
    });

    expect(api!.events.map((event) => event.seq)).toEqual([1, 12]);
    expect(MockWebSocket.instances[MockWebSocket.instances.length - 1]).toBe(newestSocket);
  });

  it('keeps live events that arrive while a same-session refetch is pending', async () => {
    const refetchResult = deferred<ReturnType<typeof ev>[]>();
    let fetchCount = 0;
    vi.mocked(fetchEvents).mockImplementation(() => {
      fetchCount += 1;
      return fetchCount === 1 ? Promise.resolve([ev(1)]) : refetchResult.promise;
    });
    let api: ReturnType<typeof useSessionStream> | undefined;
    render(<Harness sid="s1" onReady={(stream) => { api = stream; }} />);
    await waitFor(() => expect(api?.events.map((event) => event.seq)).toEqual([1]));
    await waitFor(() => expect(lastSocket?.subscribes.length).toBe(1));

    const pendingRefetch = api!.refetch();
    act(() => lastSocket!.push(ev(7, 'assistant_delta', { delta: 'live' })));
    await waitFor(() => expect(api?.events.map((event) => event.seq)).toEqual([1, 7]));

    refetchResult.resolve([ev(1), ev(2), ev(3), ev(4), ev(5)]);
    await act(async () => {
      await pendingRefetch;
    });

    expect(api!.events.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5, 7]);
    const newestSocket = MockWebSocket.instances[MockWebSocket.instances.length - 1]!;
    await waitFor(() => expect(subscribeSince(newestSocket)).toBe(7));
    expect(subscribeSince(newestSocket)).toBe(7);
  });

  it('opens the relay from seq 0 when the initial REST bootstrap fails', async () => {
    vi.mocked(fetchEvents).mockRejectedValueOnce(new Error('temporary REST failure'));

    render(<Harness sid="s1" tail={50} />);

    await waitFor(() => expect(lastSocket).toBeDefined());
    await waitFor(() => expect(lastSocket!.subscribes.length).toBe(1));
    expect(lastSocket!.subscribes[0].params).toMatchObject({
      sessionId: 's1',
      since: 0,
      tail: 50,
    });
  });

  it('opens the relay from seq 0 in a microtask when the REST bootstrap stays pending', async () => {
    vi.mocked(fetchEvents).mockReturnValueOnce(new Promise(() => {}));
    render(<Harness sid="s1" tail={50} />);
    expect(lastSocket).toBeUndefined();

    await act(async () => {
      await Promise.resolve();
    });

    expect(lastSocket).toBeDefined();
    await act(async () => Promise.resolve());
    expect(lastSocket!.subscribes[0].params).toMatchObject({
      sessionId: 's1',
      since: 0,
      tail: 50,
    });
  });

  it('merges a late REST bootstrap with RAF-pending live events without duplicates or cursor regression', async () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((callback: FrameRequestCallback) => {
        frames.push(callback);
        return frames.length;
      }),
    );
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    const bootstrap = deferred<ReturnType<typeof ev>[]>();
    vi.mocked(fetchEvents).mockReturnValueOnce(bootstrap.promise);
    let api: ReturnType<typeof useSessionStream> | undefined;

    render(<Harness sid="s1" tail={50} onReady={(stream) => { api = stream; }} />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(lastSocket).toBeDefined();
    await act(async () => {
      await Promise.resolve();
    });
    expect(lastSocket!.subscribes).toHaveLength(1);
    expect(subscribeSince(lastSocket!)).toBe(0);

    act(() => {
      lastSocket!.push(ev(3, 'assistant_delta', { delta: 'live-3' }));
      lastSocket!.push(ev(4, 'assistant_delta', { delta: 'live-4' }));
    });
    expect(frames).toHaveLength(1);

    bootstrap.resolve([ev(1), ev(2), ev(3, 'assistant_delta', { delta: 'live-3' })]);
    await act(async () => {
      await bootstrap.promise;
      await Promise.resolve();
    });
    expect(api!.events.map((event) => event.seq)).toEqual([1, 2, 3]);
    expect(MockWebSocket.instances).toHaveLength(1);
    expect(lastSocket!.subscribes).toHaveLength(1);

    act(() => frames.shift()?.(16));
    expect(api!.events.map((event) => event.seq)).toEqual([1, 2, 3, 4]);

    act(() => document.dispatchEvent(new Event('visibilitychange')));
    expect(lastSocket!.subscribes).toHaveLength(2);
    expect(subscribeSince(lastSocket!)).toBe(4);
  });

  it('visibility recovery resubscribes from the highest live seq', async () => {
    vi.mocked(fetchEvents).mockResolvedValue([ev(1)]);
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    render(<Harness sid="s1" />);
    await waitFor(() => expect(lastSocket?.subscribes.length).toBe(1));

    act(() => lastSocket!.push(ev(7, 'assistant_delta', { delta: 'live' })));
    act(() => document.dispatchEvent(new Event('visibilitychange')));

    await waitFor(() => expect(lastSocket!.subscribes.length).toBe(2));
    expect(subscribeSince(lastSocket!)).toBe(7);
  });

  it('reconnects after a socket drop and resubscribes with the updated cursor', async () => {
    vi.mocked(fetchEvents).mockResolvedValue([ev(1)]);
    const { getByTestId } = render(<Harness sid="s1" />);
    await waitFor(() => expect(lastSocket).toBeDefined());
    await waitFor(() => expect(lastSocket!.subscribes.length).toBe(1));

    act(() => lastSocket!.push(ev(2, 'assistant_message', { text: 'live' })));
    await waitFor(() => expect(getByTestId('count').textContent).toBe('2'));

    const dropped = lastSocket!;
    const countBefore = MockWebSocket.instances.length;
    act(() => dropped.drop());

    await waitFor(() => expect(MockWebSocket.instances.length).toBeGreaterThan(countBefore), {
      timeout: 5000,
    });
    const reconnected = MockWebSocket.instances[MockWebSocket.instances.length - 1]!;
    await waitFor(() => expect(reconnected.subscribes.length).toBe(1));
    expect(subscribeSince(reconnected)).toBe(2);
  }, 10000);

  it('fills the reconnect gap without duplicate seqs after a drop', async () => {
    vi.mocked(fetchEvents).mockResolvedValue([ev(1)]);
    let latest: ReturnType<typeof useSessionStream> | undefined;
    render(<Harness sid="s1" onReady={(stream) => { latest = stream; }} />);
    await waitFor(() => expect(lastSocket).toBeDefined());
    await waitFor(() => expect(lastSocket!.subscribes.length).toBe(1));

    act(() => lastSocket!.push(ev(2, 'assistant_delta', { delta: 'Hel' })));
    await waitFor(() => expect(latest?.events.map((event) => event.seq)).toEqual([1, 2]));

    const dropped = lastSocket!;
    const countBefore = MockWebSocket.instances.length;
    act(() => dropped.drop());

    await waitFor(() => expect(MockWebSocket.instances.length).toBeGreaterThan(countBefore), {
      timeout: 5000,
    });
    const reconnected = MockWebSocket.instances[MockWebSocket.instances.length - 1]!;
    await waitFor(() => expect(reconnected.subscribes.length).toBe(1));
    expect(subscribeSince(reconnected)).toBe(2);

    act(() => {
      reconnected.push(ev(3, 'assistant_delta', { delta: 'lo' }));
      reconnected.push(ev(4, 'assistant_message', { text: 'Hello' }));
      reconnected.push(ev(4, 'assistant_message', { text: 'Hello' }));
    });

    await waitFor(() => expect(latest?.events.map((event) => event.seq)).toEqual([1, 2, 3, 4]));
    expect(new Set(latest!.events.map((event) => event.seq)).size).toBe(latest!.events.length);
  }, 10000);

  it('resubscribes from the last seen seq when the server marks the stream behind', async () => {
    vi.mocked(fetchEvents).mockResolvedValue([ev(1)]);
    render(<Harness sid="s1" />);
    await waitFor(() => expect(lastSocket).toBeDefined());
    await waitFor(() => expect(lastSocket!.subscribes.length).toBe(1));

    act(() => lastSocket!.push(ev(6, 'assistant_delta', { delta: 'x' })));
    act(() =>
      lastSocket!.fire('message', { data: JSON.stringify({ channel: 's1', behind: true }) }),
    );
    await waitFor(() => expect(lastSocket!.subscribes.length).toBe(2));
    expect(subscribeSince(lastSocket!)).toBe(6);
  });

  it('resubscribes from last seen seq on server_shutdown without wiping events', async () => {
    vi.mocked(fetchEvents).mockResolvedValue([ev(1)]);
    let latest: ReturnType<typeof useSessionStream> | undefined;
    render(<Harness sid="s1" onReady={(stream) => { latest = stream; }} />);
    await waitFor(() => expect(lastSocket).toBeDefined());
    await waitFor(() => expect(lastSocket!.subscribes.length).toBe(1));

    act(() => lastSocket!.push(ev(2, 'assistant_delta', { delta: 'hi' })));
    await waitFor(() => expect(latest?.events.map((event) => event.seq)).toEqual([1, 2]));

    act(() =>
      lastSocket!.fire('message', { data: JSON.stringify({ notice: 'server_shutdown' }) }),
    );
    await waitFor(() => expect(lastSocket!.subscribes.length).toBe(2));
    expect(subscribeSince(lastSocket!)).toBe(2);
    expect(latest?.events.map((event) => event.seq)).toEqual([1, 2]);
  });
});
