import type { ComponentProps } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SessionDetail } from './session-detail';
import type { Session, SessionEvent } from '../lib/api';
import type { ModelProvider } from '../lib/model-providers';

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 's1',
    title: 'Build feature X',
    status: 'IDLE',
    provider: 'pi',
    model: 'claude-fable-5',
    modelOptions: null,
    prompt: 'do it',
    preview: null,
    workspace: null,
    projectPath: null,
    baseBranch: null,
    worktreePath: null,
    branch: null,
    cursorBackend: null,
    cursorChatId: null,
    createdAt: Date.now() - 3_600_000,
    updatedAt: Date.now() - 120_000,
    ...overrides,
  };
}

const NO_EVENTS: SessionEvent[] = [];

async function renderDetail(
  overrides: Partial<Session> = {},
  events: SessionEvent[] = NO_EVENTS,
  providers?: ModelProvider[],
  extraProps: Partial<ComponentProps<typeof SessionDetail>> = {},
) {
  const onSteer = vi.fn();
  const onPause = vi.fn();
  const onArchive = vi.fn();
  const view = render(
    <SessionDetail
      session={makeSession(overrides)}
      events={events}
      providers={providers}
      onSteer={onSteer}
      onPause={onPause}
      onArchive={onArchive}
      {...extraProps}
    />,
  );
  return { onSteer, onPause, onArchive, ...view };
}

describe('SessionDetail', () => {
  it('calls onSteer with the message when send is clicked', async () => {
    const { onSteer } = await renderDetail();
    const textarea = screen.getByPlaceholderText(/steer the agent/i);
    await userEvent.type(textarea, 'Use the cache layer');
    await userEvent.click(screen.getByRole('button', { name: /send/i }));
    expect(onSteer).toHaveBeenCalledWith('Use the cache layer');
  });

  it('clears the composer immediately after sending while steer is still settling', async () => {
    let resolveSteer!: () => void;
    const onSteer = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveSteer = resolve;
        }),
    );
    render(
      <SessionDetail
        session={makeSession()}
        events={NO_EVENTS}
        onSteer={onSteer}
        onPause={vi.fn()}
        onArchive={vi.fn()}
      />,
    );

    const textarea = screen.getByPlaceholderText(/steer the agent/i);
    await userEvent.type(textarea, 'Use the cache layer');
    await userEvent.click(screen.getByRole('button', { name: /send/i }));

    expect(onSteer).toHaveBeenCalledWith('Use the cache layer');
    expect(textarea).toHaveValue('');
    resolveSteer();
  });

  it('calls onPause when the pause button is clicked while IDLE', async () => {
    const { onPause } = await renderDetail({ status: 'IDLE' });
    await userEvent.click(screen.getByRole('button', { name: /pause session/i }));
    expect(onPause).toHaveBeenCalledTimes(1);
  });

  it('calls onArchive when the archive button is clicked', async () => {
    const { onArchive } = await renderDetail();
    await userEvent.click(screen.getByRole('button', { name: /archive session/i }));
    expect(onArchive).toHaveBeenCalledTimes(1);
  });

  it('shows Stop instead of Send when RUNNING and Stop calls onPause', async () => {
    const { onPause } = await renderDetail({ status: 'RUNNING' });
    expect(screen.queryByRole('button', { name: /send/i })).toBeNull();
    const stop = screen.getByRole('button', { name: /stop session/i });
    expect(stop).toBeEnabled();
    await userEvent.click(stop);
    expect(onPause).toHaveBeenCalledTimes(1);
  });

  it('hides header pause when RUNNING but keeps archive', async () => {
    await renderDetail({ status: 'RUNNING' });
    expect(screen.queryByRole('button', { name: /pause session/i })).toBeNull();
    expect(screen.getByRole('button', { name: /archive session/i })).toBeInTheDocument();
  });

  it('hides the pause button when the session is ARCHIVED', async () => {
    await renderDetail({ status: 'ARCHIVED' });
    expect(screen.queryByRole('button', { name: /pause session/i })).toBeNull();
  });

  it('shows Nuncio is working indicator when RUNNING with no content', async () => {
    await renderDetail({ status: 'RUNNING' });
    expect(screen.getByTestId('working-indicator')).toHaveTextContent(/Nuncio is working/i);
  });

  it('shows Nuncio is writing when RUNNING with streaming deltas', async () => {
    const events: SessionEvent[] = [
      { seq: 1, type: 'assistant_delta', payload: { delta: 'Hello' }, createdAt: Date.now() },
    ];
    await renderDetail({ status: 'RUNNING' }, events);
    expect(screen.getByTestId('working-indicator')).toHaveTextContent(/Nuncio is writing/i);
  });

  it('renders the working indicator BELOW the user message, not above it', async () => {
    const events: SessionEvent[] = [
      { seq: 1, type: 'user_message', payload: { text: 'do the thing' }, createdAt: Date.now() },
    ];
    await renderDetail({ status: 'RUNNING' }, events);
    const indicator = screen.getByTestId('working-indicator');
    const userMsg = screen.getByText('do the thing');
    // Indicator must follow the user message in DOM order (below, not above).
    const position = userMsg.compareDocumentPosition(indicator);
    expect(position & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // And it must NOT precede the user message.
    expect(position & Node.DOCUMENT_POSITION_PRECEDING).toBeFalsy();
  });

  it('renders the working indicator after the last user message when deltas exist', async () => {
    const events: SessionEvent[] = [
      { seq: 1, type: 'user_message', payload: { text: 'first prompt' }, createdAt: Date.now() },
      { seq: 2, type: 'assistant_delta', payload: { delta: 'streaming reply' }, createdAt: Date.now() },
    ];
    await renderDetail({ status: 'RUNNING' }, events);
    const indicator = screen.getByTestId('working-indicator');
    const userMsg = screen.getByText('first prompt');
    const position = userMsg.compareDocumentPosition(indicator);
    expect(position & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('renders provider approval requests and sends an approve decision', async () => {
    const onRespondProviderRequest = vi.fn();
    const events: SessionEvent[] = [
      {
        seq: 1,
        type: 'provider_request',
        payload: {
          requestId: 'req-1',
          provider: 'codex',
          method: 'exec/approval',
          status: 'pending',
          params: { command: 'git status' },
        },
        createdAt: Date.now(),
      },
    ];

    await renderDetail(
      { status: 'RUNNING', provider: 'codex' },
      events,
      undefined,
      { onRespondProviderRequest },
    );

    expect(screen.getByText('git status')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /approve request/i }));
    expect(onRespondProviderRequest).toHaveBeenCalledWith('req-1', 'approve');
  });

  it('marks provider approval requests as resolved', async () => {
    const events: SessionEvent[] = [
      {
        seq: 1,
        type: 'provider_request',
        payload: {
          requestId: 'req-1',
          provider: 'codex',
          method: 'exec/approval',
          status: 'pending',
          params: { command: 'git status' },
        },
        createdAt: Date.now(),
      },
      {
        seq: 2,
        type: 'provider_request_resolved',
        payload: { requestId: 'req-1', decision: 'deny', status: 'resolved' },
        createdAt: Date.now(),
      },
    ];

    await renderDetail({ status: 'RUNNING', provider: 'codex' }, events);

    expect(screen.getByText(/denied/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /approve request/i })).toBeNull();
  });

  it('does not render a Home button or Home text in the session header', async () => {
    await renderDetail();
    expect(screen.queryByRole('button', { name: /home/i })).toBeNull();
    expect(screen.queryByText(/^home$/i)).toBeNull();
  });

  it('does not auto-scroll transcript on delta updates', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const events: SessionEvent[] = [
      { seq: 1, type: 'user_message', payload: { text: 'Hi' }, createdAt: Date.now() },
    ];
    const { rerender } = await renderDetail({ status: 'RUNNING' }, events);

    const scrollEl = document.querySelector('.overflow-y-auto') as HTMLDivElement;
    expect(scrollEl).toBeTruthy();
    scrollEl.scrollTop = 0;

    const moreEvents: SessionEvent[] = [
      ...events,
      { seq: 2, type: 'assistant_delta', payload: { delta: 'A'.repeat(200) }, createdAt: Date.now() },
    ];
    rerender(
      <SessionDetail
        session={makeSession({ status: 'RUNNING' })}
        events={moreEvents}
        onSteer={vi.fn()}
        onPause={vi.fn()}
        onArchive={vi.fn()}
      />,
    );

    expect(scrollEl.scrollTop).toBe(0);
    vi.useRealTimers();
  });

  it('shows repo and branch badges when workspace metadata is present', async () => {
    await renderDetail({
      projectPath: '/Users/dev/code/nuncio',
      branch: 'nuncio/s1-fix-auth',
    });
    expect(screen.getAllByText('nuncio').length).toBeGreaterThan(0);
    expect(screen.getAllByText('nuncio/s1-fix-auth').length).toBeGreaterThan(0);
  });

  it('shows the friendly model name from the provided providers catalog', async () => {
    const providers: ModelProvider[] = [
      {
        id: 'cursor',
        name: 'Cursor',
        groups: [
          {
            id: 'cursor',
            name: 'Cursor',
            models: [{ id: 'cursor:composer-2.5', name: 'Composer 2.5' }],
          },
        ],
      },
    ];
    await renderDetail({ provider: 'cursor', model: 'cursor:composer-2.5' }, NO_EVENTS, providers);
    expect(screen.getByText('Composer 2.5')).toBeInTheDocument();
    expect(screen.queryByText('cursor:composer-2.5')).toBeNull();
  });

  it('prettifies a raw cursor model slug into a readable name', async () => {
    const providers: ModelProvider[] = [
      {
        id: 'cursor',
        name: 'Cursor',
        groups: [
          {
            id: 'cursor',
            name: 'Cursor',
            models: [{ id: 'cursor:composer-2.5', name: 'composer-2.5' }],
          },
        ],
      },
    ];
    await renderDetail({ provider: 'cursor', model: 'cursor:composer-2.5' }, NO_EVENTS, providers);
    expect(screen.getByText('Composer 2.5')).toBeInTheDocument();
    expect(screen.queryByText('composer-2.5')).toBeNull();
  });

  it('falls back to the raw model id when the model is not in the catalog', async () => {
    await renderDetail({ model: 'unknown:model-x' }, NO_EVENTS, []);
    expect(screen.getByText('unknown:model-x')).toBeInTheDocument();
  });

  it('shows approval mode in the steer composer for Codex sessions only', async () => {
    const codexView = await renderDetail(
      { provider: 'codex', model: 'codex:gpt-5.5' },
      NO_EVENTS,
      [
        {
          id: 'codex',
          name: 'Codex',
          groups: [
            {
              id: 'codex',
              name: 'Codex',
              models: [{ id: 'codex:gpt-5.5', name: 'GPT 5.5' }],
            },
          ],
        },
      ],
      { approvalMode: 'full-access', onApprovalModeChange: vi.fn() },
    );
    const approval = screen.getByRole('button', { name: /approval mode: full access/i });
    expect(approval).toBeInTheDocument();
    expect(approval).toHaveAttribute('data-variant', 'ghost');
    expect(approval).not.toHaveClass('composer-picker-trigger');
    codexView.unmount();

    await renderDetail(
      { provider: 'cursor', model: 'cursor:composer-2.5' },
      NO_EVENTS,
      [
        {
          id: 'cursor',
          name: 'Cursor',
          groups: [
            {
              id: 'cursor',
              name: 'Cursor',
              models: [{ id: 'cursor:composer-2.5', name: 'Composer 2.5' }],
            },
          ],
        },
      ],
      { approvalMode: 'full-access', onApprovalModeChange: vi.fn() },
    );
    expect(screen.queryByRole('button', { name: /approval mode/i })).toBeNull();
  });

  describe('archived actions', () => {
    async function renderArchived(handlers: {
      onRestore?: (id: string) => void | Promise<void>;
      onDelete?: (id: string) => void | Promise<void>;
    } = {}) {
      const onSteer = vi.fn();
      const onPause = vi.fn();
      const onArchive = vi.fn();
      const onRestore = handlers.onRestore ?? vi.fn();
      const onDelete = handlers.onDelete ?? vi.fn();
      const view = render(
        <SessionDetail
          session={makeSession({ id: 's1', status: 'ARCHIVED' })}
          events={NO_EVENTS}
          onSteer={onSteer}
          onPause={onPause}
          onArchive={onArchive}
          onRestore={onRestore}
          onDelete={onDelete}
        />,
      );
      return { onSteer, onPause, onArchive, onRestore, onDelete, ...view };
    }

    it('shows a Restore button when the session is ARCHIVED', async () => {
      await renderArchived();
      expect(screen.getByRole('button', { name: /restore session/i })).toBeInTheDocument();
    });

    it('hides the archive button when the session is ARCHIVED', async () => {
      await renderArchived();
      expect(screen.queryByRole('button', { name: /archive session/i })).toBeNull();
    });

    it('calls onRestore with the session id when Restore is clicked', async () => {
      const { onRestore } = await renderArchived();
      await userEvent.click(screen.getByRole('button', { name: /restore session/i }));
      expect(onRestore).toHaveBeenCalledWith('s1');
    });

    it('shows a Delete button when the session is ARCHIVED', async () => {
      await renderArchived();
      expect(screen.getByRole('button', { name: /delete session/i })).toBeInTheDocument();
    });

    it('opens a confirmation dialog and only deletes after confirming', async () => {
      const { onDelete } = await renderArchived();
      await userEvent.click(screen.getByRole('button', { name: /delete session/i }));
      expect(onDelete).not.toHaveBeenCalled();
      expect(await screen.findByRole('heading', { name: /delete session/i })).toBeInTheDocument();
      await userEvent.click(screen.getByRole('button', { name: /delete forever/i }));
      expect(onDelete).toHaveBeenCalledWith('s1');
    });

    it('cancel in the confirm dialog does not delete', async () => {
      const { onDelete } = await renderArchived();
      await userEvent.click(screen.getByRole('button', { name: /delete session/i }));
      await userEvent.click(screen.getByRole('button', { name: /cancel/i }));
      expect(onDelete).not.toHaveBeenCalled();
    });

    it('does not render Restore / Delete when the session is not archived', async () => {
      const view = render(
        <SessionDetail
          session={makeSession({ status: 'IDLE' })}
          events={NO_EVENTS}
          onSteer={vi.fn()}
          onPause={vi.fn()}
          onArchive={vi.fn()}
          onRestore={vi.fn()}
          onDelete={vi.fn()}
        />,
      );
      expect(view.queryByRole('button', { name: /restore session/i })).toBeNull();
      expect(view.queryByRole('button', { name: /delete session/i })).toBeNull();
    });
  });
});

describe('SessionDetail throttled streaming', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reveals assistant deltas gradually while RUNNING', async () => {
    const longDelta = 'x'.repeat(120);
    const events: SessionEvent[] = [
      { seq: 1, type: 'assistant_delta', payload: { delta: longDelta }, createdAt: Date.now() },
    ];
    await renderDetail({ status: 'RUNNING' }, events);

    act(() => {
      vi.advanceTimersByTime(100);
    });

    const assistantBubble = screen.getByText(/^x{1,119}$/);
    expect(assistantBubble.textContent?.length).toBeLessThan(longDelta.length);

    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(assistantBubble.textContent?.length).toBeGreaterThan(40);
    expect(assistantBubble.textContent?.length).toBeLessThan(longDelta.length);
  });

  it('flushes throttled text when assistant_message arrives', async () => {
    const full = 'Complete response text here';
    const events: SessionEvent[] = [
      { seq: 1, type: 'assistant_delta', payload: { delta: full }, createdAt: Date.now() },
      { seq: 2, type: 'assistant_message', payload: { text: full }, createdAt: Date.now() },
    ];
    await renderDetail({ status: 'IDLE' }, events);
    expect(screen.getByText(full)).toBeInTheDocument();
  });

  it('shows Continue on mobile for SDK Cursor sessions when handler provided', async () => {
    const onContinue = vi.fn();
    render(
      <SessionDetail
        session={makeSession({ provider: 'cursor', cursorBackend: 'sdk' })}
        events={NO_EVENTS}
        onSteer={vi.fn()}
        onPause={vi.fn()}
        onArchive={vi.fn()}
        onContinueOnMobile={onContinue}
      />,
    );
    const btn = screen.getByRole('button', { name: /continue on mobile/i });
    expect(btn).toBeInTheDocument();
    await userEvent.click(btn);
    expect(onContinue).toHaveBeenCalledTimes(1);
  });

  it('hides Continue on mobile for CLI handoff sessions', async () => {
    render(
      <SessionDetail
        session={makeSession({ provider: 'cursor', cursorBackend: 'cli' })}
        events={NO_EVENTS}
        onSteer={vi.fn()}
        onPause={vi.fn()}
        onArchive={vi.fn()}
        onContinueOnMobile={vi.fn()}
      />,
    );
    expect(screen.queryByRole('button', { name: /continue on mobile/i })).toBeNull();
    expect(screen.getByText('Imported from Cursor')).toBeInTheDocument();
  });
});
