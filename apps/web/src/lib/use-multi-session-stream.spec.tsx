import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, waitFor, act } from '@testing-library/react';
import { useMultiSessionStream } from './use-multi-session-stream';

vi.mock('./api', () => ({ fetchEvents: vi.fn() }));

import { fetchEvents } from './api';

type MessageEventLike = { data: string };

class MockEventSource {
  url: string;
  onmessage: ((msg: MessageEventLike) => void) | null = null;
  onerror: (() => void) | null = null;
  close = vi.fn();
  constructor(url: string) {
    this.url = url;
    lastSource = this;
    sources.push(this);
  }
}

let lastSource: MockEventSource | undefined;
const sources: MockEventSource[] = [];

function ev(seq: number, type = 'status', payload: Record<string, unknown> = {}) {
  return { seq, type, payload, createdAt: 0 };
}

function Harness({ ids }: { ids: string[] }) {
  const eventsById = useMultiSessionStream(ids);
  return (
    <div>
      {ids.map((id) => (
        <span key={id} data-testid={`count-${id}`}>
          {(eventsById[id] ?? []).length}
        </span>
      ))}
    </div>
  );
}

describe('useMultiSessionStream', () => {
  beforeEach(() => {
    vi.stubGlobal('EventSource', MockEventSource);
    vi.mocked(fetchEvents).mockReset();
    lastSource = undefined;
    sources.length = 0;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('seeds each session from fetchEvents and opens ONE EventSource for all of them', async () => {
    vi.mocked(fetchEvents).mockImplementation(async (id: string) =>
      id === 'a' ? [ev(1), ev(2)] : [ev(5)],
    );
    const { getByTestId } = render(<Harness ids={['a', 'b']} />);

    await waitFor(() => expect(getByTestId('count-a').textContent).toBe('2'));
    await waitFor(() => expect(getByTestId('count-b').textContent).toBe('1'));

    expect(sources).toHaveLength(1);
    expect(lastSource!.url).toContain('/api/sessions/stream/multi');
    expect(lastSource!.url).toContain('a%3A2');
    expect(lastSource!.url).toContain('b%3A5');
  });

  it('routes tagged live events to the right session bucket', async () => {
    vi.mocked(fetchEvents).mockResolvedValue([]);
    const { getByTestId } = render(<Harness ids={['a', 'b']} />);
    await waitFor(() => expect(sources).toHaveLength(1));

    act(() => {
      lastSource!.onmessage?.({ data: JSON.stringify({ sessionId: 'b', ...ev(1) }) });
      lastSource!.onmessage?.({ data: JSON.stringify({ sessionId: 'b', ...ev(2) }) });
      lastSource!.onmessage?.({ data: JSON.stringify({ sessionId: 'a', ...ev(1) }) });
    });

    expect(getByTestId('count-a').textContent).toBe('1');
    expect(getByTestId('count-b').textContent).toBe('2');
  });

  it('ignores duplicate seqs per session', async () => {
    vi.mocked(fetchEvents).mockResolvedValue([ev(1)]);
    const { getByTestId } = render(<Harness ids={['a']} />);
    await waitFor(() => expect(sources).toHaveLength(1));

    act(() => {
      lastSource!.onmessage?.({ data: JSON.stringify({ sessionId: 'a', ...ev(1) }) });
      lastSource!.onmessage?.({ data: JSON.stringify({ sessionId: 'a', ...ev(2) }) });
    });

    expect(getByTestId('count-a').textContent).toBe('2');
  });

  it('reconnects with per-session since after an error', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.mocked(fetchEvents).mockResolvedValue([]);
    render(<Harness ids={['a']} />);
    await waitFor(() => expect(sources).toHaveLength(1));

    act(() => {
      lastSource!.onmessage?.({ data: JSON.stringify({ sessionId: 'a', ...ev(7) }) });
      lastSource!.onerror?.();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500);
    });

    expect(sources.length).toBeGreaterThanOrEqual(2);
    expect(lastSource!.url).toContain('a%3A7');
  });
});
