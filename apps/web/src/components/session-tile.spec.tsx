import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Session, SessionEvent } from '../lib/api';

// Feed a controlled event stream; the real transcript + pending-input derivations run.
let streamEvents: SessionEvent[] = [];
vi.mock('../lib/use-session-stream', () => ({
  useSessionStream: () => ({ events: streamEvents, refetch: vi.fn() }),
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
    streamEvents = [];
  });

  it('renders at most 30 tail blocks for a long event log', () => {
    streamEvents = Array.from({ length: 40 }, (_, i) => assistantEvent(i + 1, `line ${i + 1}`));
    render(
      <SessionTile session={fakeSession()} focused={false} onFocus={noop} onMaximize={noop} />,
    );
    // First 10 lines are dropped by the .slice(-30) tail; last 30 are present.
    expect(screen.queryByText('line 10')).not.toBeInTheDocument();
    expect(screen.getByText('line 11')).toBeInTheDocument();
    expect(screen.getByText('line 40')).toBeInTheDocument();
  });

  it('shows the success border when RUNNING', () => {
    streamEvents = [statusEvent(1, 'RUNNING')];
    const { container } = render(
      <SessionTile
        session={fakeSession({ status: 'RUNNING' })}
        focused={false}
        onFocus={noop}
        onMaximize={noop}
      />,
    );
    expect(container.querySelector('.border-success\\/70')).toBeTruthy();
  });

  it('shows the destructive border when ERROR', () => {
    streamEvents = [statusEvent(1, 'ERROR')];
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
    streamEvents = [statusEvent(1, 'IDLE')];
    const { container } = render(
      <SessionTile session={fakeSession()} focused={false} onFocus={noop} onMaximize={noop} />,
    );
    expect(container.querySelector('.border-border')).toBeTruthy();
  });

  it('shows the warning pulse border when an input request is open, overriding run state', () => {
    streamEvents = [
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
    // Pending input takes precedence: no run-state success border applied.
    expect(container.querySelector('.border-success\\/70')).toBeNull();
  });

  it('shows the steer input on every tile — each cell is a chat box', () => {
    streamEvents = [statusEvent(1, 'IDLE')];
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
    streamEvents = [statusEvent(1, 'IDLE')];
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
});
