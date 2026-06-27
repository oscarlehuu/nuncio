import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { useSessionStream } from './use-session-stream';

vi.mock('./api', () => ({ fetchEvents: vi.fn() }));

import { fetchEvents } from './api';

type MessageEventLike = { data: string };

class MockEventSource {
  url: string;
  onmessage: ((msg: MessageEventLike) => void) | null = null;
  close = vi.fn();
  constructor(url: string) {
    this.url = url;
    lastSource = this;
  }
}

let lastSource: MockEventSource | undefined;

function ev(seq: number, type = 'status', payload: Record<string, unknown> = {}) {
  return { seq, type, payload, createdAt: 0 };
}

function Harness({ sid }: { sid: string | null }) {
  const events = useSessionStream(sid);
  return <div data-testid="count">{events.length}</div>;
}

describe('useSessionStream', () => {
  beforeEach(() => {
    vi.stubGlobal('EventSource', MockEventSource);
    vi.mocked(fetchEvents).mockReset();
    lastSource = undefined;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('seeds events from fetchEvents on mount', async () => {
    vi.mocked(fetchEvents).mockResolvedValue([ev(1), ev(2)]);
    const { getByTestId } = render(<Harness sid="s1" />);
    await waitFor(() => expect(getByTestId('count').textContent).toBe('2'));
    expect(fetchEvents).toHaveBeenCalledWith('s1', 0);
  });

  it('appends events delivered over the EventSource stream', async () => {
    vi.mocked(fetchEvents).mockResolvedValue([ev(1)]);
    const { getByTestId } = render(<Harness sid="s1" />);
    await waitFor(() => expect(getByTestId('count').textContent).toBe('1'));
    await waitFor(() => expect(lastSource).toBeDefined());

    lastSource!.onmessage!({ data: JSON.stringify(ev(2, 'assistant_message', { text: 'hi' })) });
    await waitFor(() => expect(getByTestId('count').textContent).toBe('2'));
  });

  it('deduplicates events by seq', async () => {
    vi.mocked(fetchEvents).mockResolvedValue([ev(1)]);
    const { getByTestId } = render(<Harness sid="s1" />);
    await waitFor(() => expect(getByTestId('count').textContent).toBe('1'));
    await waitFor(() => expect(lastSource).toBeDefined());

    lastSource!.onmessage!({ data: JSON.stringify(ev(1)) }); // same seq -> ignored
    expect(getByTestId('count').textContent).toBe('1');
  });

  it('clears events and skips fetch when the session id is null', async () => {
    vi.mocked(fetchEvents).mockResolvedValue([ev(1)]);
    const { getByTestId } = render(<Harness sid={null} />);
    await waitFor(() => expect(getByTestId('count').textContent).toBe('0'));
    expect(fetchEvents).not.toHaveBeenCalled();
    expect(lastSource).toBeUndefined();
  });

  it('connects the EventSource to the stream url with the since cursor', async () => {
    vi.mocked(fetchEvents).mockResolvedValue([ev(1), ev(5)]);
    render(<Harness sid="s1" />);
    await waitFor(() => expect(lastSource).toBeDefined());
    expect(lastSource!.url).toBe('/api/sessions/s1/stream?since=5');
  });
});
