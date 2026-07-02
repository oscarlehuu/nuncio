import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, waitFor, act } from '@testing-library/react';
import { useSessionStream } from './use-session-stream';

vi.mock('./api', () => ({ fetchEvents: vi.fn() }));

import { fetchEvents } from './api';

type Listener = (event: { data?: unknown }) => void;

class MockWebSocket {
  static instances: MockWebSocket[] = [];
  url: string;
  sent: Array<Record<string, unknown>> = [];
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

describe('useSessionStream', () => {
  beforeEach(() => {
    vi.stubGlobal('WebSocket', MockWebSocket);
    vi.mocked(fetchEvents).mockReset();
    lastSocket = undefined;
    MockWebSocket.instances.length = 0;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
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

  it('clears events and skips fetch when the session id is null', async () => {
    vi.mocked(fetchEvents).mockResolvedValue([ev(1)]);
    const { getByTestId } = render(<Harness sid={null} />);
    await waitFor(() => expect(getByTestId('count').textContent).toBe('0'));
    expect(fetchEvents).not.toHaveBeenCalled();
    expect(lastSocket).toBeUndefined();
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
    expect(MockWebSocket.instances.length).toBeGreaterThanOrEqual(2);
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
});
