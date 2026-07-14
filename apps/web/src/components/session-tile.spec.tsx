import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Session, SessionEvent } from '../lib/api';

// Feed a controlled event stream; the real transcript + pending-input derivations run.
const streamState = vi.hoisted(() => ({
  events: [] as SessionEvent[],
  hasEarlier: false,
  loadEarlier: vi.fn(),
  calls: [] as Array<[string | null, string, number | undefined]>,
}));

vi.mock('../lib/use-session-stream', () => ({
  DETAIL_EVENT_TAIL: 1000,
  useSessionStream: (sessionId: string | null, base = '', tail?: number) => {
    streamState.calls.push([sessionId, base, tail]);
    return {
      events: streamState.events,
      refetch: vi.fn(),
      loadEarlier: streamState.loadEarlier,
      hasEarlier: streamState.hasEarlier,
    };
  },
}));

import { SessionTile } from './session-tile';

function fakeSession(over: Partial<Session> = {}): Session {
  return {
    id: 's1',
    title: 'Refactor the parser',
    status: 'IDLE',
    provider: 'pi',
    model: 'claude-opus-4-8',
    modelOptions: null,
    prompt: 'refactor',
    preview: null,
    workspace: null,
    projectPath: '/code/nuncio',
    baseBranch: null,
    worktreePath: null,
    branch: null,
    cursorBackend: null,
    cursorChatId: null,
    supportsInteraction: true,
    createdAt: 0,
    updatedAt: 0,
    ...over,
  };
}

function assistantEvent(seq: number, text: string): SessionEvent {
  return { seq, type: 'assistant_message', payload: { text }, createdAt: seq };
}

function statusEvent(seq: number, status: string): SessionEvent {
  return { seq, type: 'status', payload: { status }, createdAt: seq };
}

const noop = () => {};

describe('SessionTile', () => {
  beforeEach(() => {
    streamState.events = [];
    streamState.hasEarlier = false;
    streamState.loadEarlier.mockReset();
    streamState.calls = [];
  });

  it('renders the full loaded transcript window instead of dropping early chat blocks', () => {
    streamState.events = Array.from({ length: 40 }, (_, i) => assistantEvent(i + 1, `line ${i + 1}`));
    render(
      <SessionTile session={fakeSession()} focused={false} onFocus={noop} onMaximize={noop} />,
    );
    expect(screen.getByText('line 1')).toBeInTheDocument();
    expect(screen.getByText('line 40')).toBeInTheDocument();
    expect(streamState.calls[0]).toEqual(['s1', '', 1000]);
  });

  it('can page older history inside the workbench tile', async () => {
    streamState.events = [assistantEvent(40, 'latest line')];
    streamState.hasEarlier = true;
    render(
      <SessionTile session={fakeSession()} focused={false} onFocus={noop} onMaximize={noop} />,
    );

    await userEvent.click(screen.getByRole('button', { name: /load earlier history/i }));
    expect(streamState.loadEarlier).toHaveBeenCalledTimes(1);
  });

  it('shows the neutral breathing border when RUNNING', () => {
    streamState.events = [statusEvent(1, 'RUNNING')];
    render(
      <SessionTile
        session={fakeSession({ status: 'RUNNING' })}
        focused={false}
        onFocus={noop}
        onMaximize={noop}
      />,
    );
    expect(screen.getByRole('button', { name: /session refactor the parser/i })).toHaveClass('border-border');
  });

  it('shows the destructive border when ERROR', () => {
    streamState.events = [statusEvent(1, 'ERROR')];
    const { container } = render(
      <SessionTile
        session={fakeSession({ status: 'ERROR' })}
        focused={false}
        onFocus={noop}
        onMaximize={noop}
      />,
    );
    expect(container.querySelector('.border-destructive')).toBeTruthy();
  });

  it('shows the muted border when IDLE', () => {
    streamState.events = [statusEvent(1, 'IDLE')];
    render(
      <SessionTile session={fakeSession()} focused={false} onFocus={noop} onMaximize={noop} />,
    );
    expect(screen.getByRole('button', { name: /session refactor the parser/i })).toHaveClass('border-border/60');
  });

  it('shows the warning pulse border when an input request is open, overriding run state', () => {
    streamState.events = [
      statusEvent(1, 'RUNNING'),
      {
        seq: 2,
        type: 'user_input_requested',
        payload: {
          requestId: 'req1',
          questions: [{ id: 'q1', prompt: 'Which branch?' }],
        },
        createdAt: 2,
      },
    ];
    const { container } = render(
      <SessionTile
        session={fakeSession({ status: 'RUNNING' })}
        focused={false}
        onFocus={noop}
        onMaximize={noop}
      />,
    );
    expect(container.querySelector('.border-warning')).toBeTruthy();
    expect(container.querySelector('.animate-pulse')).toBeTruthy();
    // Pending input takes precedence: no run-state neutral border applied.
    expect(screen.getByRole('button', { name: /session refactor the parser/i })).not.toHaveClass('border-border');
  });

  it('shows a verify chip when the last verify run failed', () => {
    streamState.events = [
      statusEvent(1, 'IDLE'),
      { seq: 2, type: 'verify_result', payload: { command: 'bun test', ok: false, exitCode: 1 }, createdAt: 2 },
    ];
    render(
      <SessionTile session={fakeSession()} focused={false} onFocus={noop} onMaximize={noop} />,
    );
    expect(screen.getByLabelText(/checks failed/i)).toBeInTheDocument();
  });

  it('shows no verify chip without verify events', () => {
    streamState.events = [statusEvent(1, 'IDLE')];
    render(
      <SessionTile session={fakeSession()} focused={false} onFocus={noop} onMaximize={noop} />,
    );
    expect(screen.queryByLabelText(/checks/i)).not.toBeInTheDocument();
  });

  it('shows the steer input on every tile — each cell is a chat box', () => {
    streamState.events = [statusEvent(1, 'IDLE')];
    render(
      <SessionTile
        session={fakeSession()}
        focused={false}
        onFocus={noop}
        onMaximize={noop}
        onSteer={vi.fn()}
      />,
    );
    expect(screen.getByLabelText(/steer refactor the parser/i)).toBeInTheDocument();
  });

  it('typing spaces in the steer input is not swallowed by the tile focus handler', async () => {
    streamState.events = [statusEvent(1, 'IDLE')];
    render(
      <SessionTile
        session={fakeSession()}
        focused
        onFocus={noop}
        onMaximize={noop}
        onSteer={vi.fn()}
      />,
    );

    const input = screen.getByLabelText(/steer refactor the parser/i);
    await userEvent.type(input, 'hello world');
    expect(input).toHaveValue('hello world');
  });

  it('selecting a tile lands focus in its composer so you can type at once', async () => {
    streamState.events = [statusEvent(1, 'IDLE')];
    render(
      <SessionTile
        session={fakeSession()}
        focused={false}
        onFocus={noop}
        onMaximize={noop}
        onSteer={vi.fn()}
      />,
    );
    const input = screen.getByLabelText(/steer refactor the parser/i);
    expect(input).not.toHaveFocus();
    // Click the tile surface (its title), not the input itself.
    await userEvent.click(screen.getByText('Refactor the parser'));
    expect(input).toHaveFocus();
  });

  it('does not steal composer focus when the click ends a transcript text selection', () => {
    streamState.events = [assistantEvent(1, 'copy this phrase from the tile')];
    render(
      <SessionTile
        session={fakeSession()}
        focused={false}
        onFocus={noop}
        onMaximize={noop}
        onSteer={vi.fn()}
      />,
    );
    const input = screen.getByLabelText(/steer refactor the parser/i);
    const phrase = screen.getByText(/copy this phrase from the tile/i);
    const range = document.createRange();
    range.selectNodeContents(phrase);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    // fireEvent.click alone (no mousedown) mirrors mouseup→click after a drag
    // select, where the highlight is still alive.
    fireEvent.click(phrase);
    expect(input).not.toHaveFocus();
    expect(window.getSelection()?.toString()).toContain('copy this phrase');
  });

  it('maximize hands up the tile rect so the full view can grow from this slot', async () => {
    streamState.events = [statusEvent(1, 'IDLE')];
    const onMaximize = vi.fn();
    render(
      <SessionTile session={fakeSession()} focused={false} onFocus={noop} onMaximize={onMaximize} />,
    );
    await userEvent.click(screen.getByRole('button', { name: /maximize refactor the parser/i }));
    expect(onMaximize).toHaveBeenCalledTimes(1);
    expect(onMaximize).toHaveBeenCalledWith(
      expect.objectContaining({ width: expect.any(Number), height: expect.any(Number) }),
    );
  });
});
