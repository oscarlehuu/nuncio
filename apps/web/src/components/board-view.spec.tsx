import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Session } from '../lib/api';
import type { ModelProvider } from '../lib/model-providers';

// Heavy, stream-driven children are irrelevant to lane grouping — stub them.
vi.mock('./home-view', () => ({
  HomeView: () => <div data-testid="home-view" />,
}));

vi.mock('./session-tile', () => ({
  SessionTile: ({ session }: { session: Session }) => (
    <div data-testid={`tile-${session.id}`}>{session.title}</div>
  ),
}));

vi.mock('./session-detail', () => ({
  SessionDetail: ({ session }: { session: Session }) => (
    <div data-testid="session-detail">detail:{session.title}</div>
  ),
}));

vi.mock('../lib/use-session-stream', () => ({
  DETAIL_EVENT_TAIL: 1000,
  useSessionStream: () => ({ events: [], refetch: vi.fn(), loadEarlier: vi.fn(), hasEarlier: false }),
}));

vi.mock('../lib/use-active-run', () => ({
  useActiveRun: () => false,
}));

import { BoardView } from './board-view';

const PROVIDERS: ModelProvider[] = [
  { id: 'pi', name: 'Pi', groups: [{ id: 'pi', name: 'Pi', models: [{ id: 'pi:default', name: 'Pi' }] }] },
];

function makeSession(over: Partial<Session>): Session {
  return {
    id: 's1',
    title: 'Session One',
    status: 'IDLE',
    provider: 'pi',
    model: 'pi:default',
    modelOptions: null,
    prompt: '',
    preview: null,
    workspace: null,
    projectPath: null,
    baseBranch: null,
    worktreePath: null,
    branch: null,
    cursorBackend: null,
    cursorChatId: null,
    supportsInteraction: true,
    createdAt: 0,
    updatedAt: 100,
    ...over,
  };
}

function renderBoard(sessions: Session[]) {
  return render(
    <BoardView
      sessions={sessions}
      providers={PROVIDERS}
      approvalMode="full-access"
      onApprovalModeChange={vi.fn()}
      onRespondProviderRequest={vi.fn()}
      onSteerSession={vi.fn()}
      onPauseSession={vi.fn()}
      onArchiveSession={vi.fn()}
      onRestore={vi.fn()}
      onDelete={vi.fn()}
      onRename={vi.fn()}
      onSubmit={vi.fn()}
    />,
  );
}

describe('BoardView left list taxonomy', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('groups sessions into workflow lanes, not raw status', () => {
    renderBoard([
      makeSession({ id: 'idle', title: 'Idle One', status: 'IDLE' }),
      makeSession({ id: 'run', title: 'Run One', status: 'RUNNING' }),
      makeSession({ id: 'new', title: 'New One', status: 'CREATED' }),
    ]);

    // Never-opened IDLE turn lands in Needs you; RUNNING → Running; CREATED → Queued.
    expect(screen.getByText('Needs you · 1')).toBeInTheDocument();
    expect(screen.getByText('Running · 1')).toBeInTheDocument();
    expect(screen.getByText('Queued · 1')).toBeInTheDocument();
  });

  it('routes a run blocked on your input to Needs you, not Running', () => {
    renderBoard([makeSession({ id: 'ask', status: 'RUNNING', pendingInput: true })]);

    expect(screen.getByText('Needs you · 1')).toBeInTheDocument();
    expect(screen.queryByText(/Running ·/)).not.toBeInTheDocument();
  });

  it('moves a session from Needs you to Seen once you open it', async () => {
    const user = userEvent.setup();
    renderBoard([makeSession({ id: 's1', title: 'Session One', status: 'IDLE' })]);

    expect(screen.getByText('Needs you · 1')).toBeInTheDocument();

    // The list row is the only button carrying the title text (tile is a stub).
    await user.click(screen.getByRole('button', { name: /Session One/ }));

    await waitFor(() => expect(screen.getByText('Seen · 1')).toBeInTheDocument());
    expect(screen.queryByText(/Needs you ·/)).not.toBeInTheDocument();
  });
});
