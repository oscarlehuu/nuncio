import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { SessionEvent } from '../lib/api';
import { Transcript } from './session-transcript';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

import { toast } from 'sonner';

function ev(seq: number, type: string, payload: Record<string, unknown>): SessionEvent {
  return { seq, type, payload, createdAt: seq };
}

const BEFORE = { id: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6', mimeType: 'image/png' };
const AFTER = { id: 'f6e5d4c3b2a1908172635445362718f0', mimeType: 'image/png' };
const VIEWPORT = { w: 1440, h: 900 };

describe('Transcript evidence dispatch', () => {
  it('renders a paired before/after block and flags divergent heads as stale', () => {
    const events = [
      ev(1, 'evidence_captured', {
        beforeRef: BEFORE,
        route: '/inbox',
        viewport: VIEWPORT,
        workspaceHead: 'head-a',
      }),
      ev(2, 'evidence_captured', {
        afterRef: AFTER,
        route: '/inbox',
        viewport: VIEWPORT,
        workspaceHead: 'head-b',
      }),
    ];
    render(<Transcript events={events} sessionId="s1" />);
    expect(screen.getByTestId('evidence-block')).toBeInTheDocument();
    expect(screen.getByAltText('Before screenshot of /inbox')).toBeInTheDocument();
    expect(screen.getByAltText('After screenshot of /inbox')).toBeInTheDocument();
    expect(screen.getByTestId('evidence-stale')).toBeInTheDocument();
  });

  it('renders an after-only capture as a single evidence block', () => {
    const events = [
      ev(1, 'evidence_captured', {
        afterRef: AFTER,
        route: '/inbox',
        viewport: VIEWPORT,
        workspaceHead: 'head-c',
      }),
    ];
    render(<Transcript events={events} sessionId="s1" />);
    expect(screen.getByTestId('evidence-block')).toBeInTheDocument();
    expect(screen.getByAltText('After screenshot of /inbox')).toBeInTheDocument();
    expect(screen.queryByTestId('evidence-stale')).not.toBeInTheDocument();
  });
});

describe('Transcript live steer projection', () => {
  it('renders a reserved steer immediately and does not duplicate it when accepted', () => {
    const events = [
      ev(1, 'user_message', { text: 'start' }),
      ev(2, 'assistant_delta', { delta: 'working' }),
      ev(3, 'steer_reserved', { text: 'change direction' }),
      ev(4, 'steer_message', { text: 'change direction' }),
    ];

    const { container } = render(<Transcript events={events} sessionId="s1" streaming />);

    expect(screen.getAllByText('change direction')).toHaveLength(1);
    expect(container.textContent?.indexOf('working')).toBeLessThan(
      container.textContent?.indexOf('change direction') ?? -1,
    );
  });
});

describe('Transcript auto-copy selection', () => {
  const writeText = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    writeText.mockClear();
    vi.mocked(toast.success).mockClear();
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
  });

  afterEach(() => {
    window.getSelection()?.removeAllRanges();
  });

  it('copies the highlighted transcript text on mouseup', async () => {
    render(
      <Transcript
        events={[ev(1, 'assistant_message', { text: 'auto copy this chat line' })]}
        sessionId="s1"
      />,
    );
    const phrase = screen.getByText(/auto copy this chat line/i);
    const root = phrase.closest('[data-chat-transcript]');
    expect(root).toBeTruthy();

    const range = document.createRange();
    range.selectNodeContents(phrase);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    fireEvent.mouseUp(root!);

    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(expect.stringContaining('auto copy this chat line')),
    );
    expect(toast.success).toHaveBeenCalledWith('Copied', { duration: 1000 });
  });
});
