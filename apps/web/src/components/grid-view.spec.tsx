import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Session } from '../lib/api';
import type { ModelProvider } from '../lib/model-providers';
import { GRID_PREFERENCE_STORAGE_KEY } from '../lib/grid-preference';

// Lightweight stand-ins so tile presence/absence is trivial to assert.
vi.mock('./session-tile', () => ({
  SessionTile: ({
    session,
    focused,
    onMaximize,
  }: {
    session: Session;
    focused: boolean;
    onMaximize: () => void;
  }) => (
    <div data-testid={`tile-${session.id}`} data-focused={focused ? 'true' : 'false'}>
      <span>{session.title}</span>
      <button type="button" onClick={onMaximize}>{`maximize-${session.id}`}</button>
    </div>
  ),
}));

vi.mock('./session-detail', () => ({
  SessionDetail: ({
    session,
    headerActions,
  }: {
    session: Session;
    headerActions?: React.ReactNode;
  }) => (
    <div data-testid="session-detail">
      detail:{session.title}
      {headerActions}
    </div>
  ),
}));

vi.mock('./grid-slot-composer', () => ({
  GridSlotComposer: ({ onCreate }: { onCreate: (prompt: string) => Promise<unknown> }) => (
    <div data-testid="empty-slot">
      <button type="button" onClick={() => void onCreate('hello from slot')}>
        create-in-slot
      </button>
      <input aria-label="slot-input" />
    </div>
  ),
}));

vi.mock('./remote-session-tile', () => ({
  RemoteSessionTile: ({
    machineId,
    sessionId,
    onGone,
  }: {
    machineId: string;
    sessionId: string;
    onGone: () => void;
  }) => (
    <div data-testid={`remote-tile-${machineId}-${sessionId}`}>
      <button type="button" onClick={onGone}>{`gone-${sessionId}`}</button>
    </div>
  ),
}));

vi.mock('../lib/use-session-stream', () => ({
  DETAIL_EVENT_TAIL: 1000,
  useSessionStream: () => ({ events: [], refetch: vi.fn(), loadEarlier: vi.fn(), hasEarlier: false }),
}));

vi.mock('../lib/use-active-run', () => ({
  useActiveRun: () => false,
}));

import { GridView } from './grid-view';

const PROVIDERS: ModelProvider[] = [
  { id: 'pi', name: 'Pi', groups: [{ id: 'pi', name: 'Pi', models: [{ id: 'pi:default', name: 'Pi' }] }] },
];

function fakeSession(over: Partial<Session> = {}): Session {
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
    updatedAt: 0,
    ...over,
  };
}

function gridElement(sessions: Session[], over: Partial<Parameters<typeof GridView>[0]> = {}) {
  return (
    <GridView
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
      onCreate={vi.fn()}
      {...over}
    />
  );
}

function renderGrid(sessions: Session[], over: Partial<Parameters<typeof GridView>[0]> = {}) {
  return render(gridElement(sessions, over));
}

function seedPreference(preset: string, slots: Array<{ sessionId?: string; machineId?: string }>) {
  localStorage.setItem(
    GRID_PREFERENCE_STORAGE_KEY,
    JSON.stringify({ version: 1, preset, slots }),
  );
}

describe('GridView', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('renders the grid header with the preset switcher', () => {
    renderGrid([]);
    expect(screen.getByRole('heading', { name: /workbench/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: '2x2' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: '3x2' })).toBeInTheDocument();
  });

  it('preset switch 2x2 -> 3x2 keeps existing bindings and adds empty slots', async () => {
    const a = fakeSession({ id: 'a', title: 'Alpha' });
    const b = fakeSession({ id: 'b', title: 'Bravo' });
    seedPreference('2x2', [{ sessionId: 'a' }, { sessionId: 'b' }, {}, {}]);
    renderGrid([a, b]);

    expect(screen.getByTestId('tile-a')).toBeInTheDocument();
    expect(screen.getByTestId('tile-b')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('tab', { name: '3x2' }));

    // Bindings survive the grow.
    expect(screen.getByTestId('tile-a')).toBeInTheDocument();
    expect(screen.getByTestId('tile-b')).toBeInTheDocument();
    // 3x2 = 6 slots => 2 tiles + 4 empty composers.
    expect(screen.getAllByTestId('empty-slot')).toHaveLength(4);
  });

  it('preset switch 3x2 -> 1x1 truncates to the first slot', async () => {
    const a = fakeSession({ id: 'a', title: 'Alpha' });
    const b = fakeSession({ id: 'b', title: 'Bravo' });
    seedPreference('3x2', [{ sessionId: 'a' }, { sessionId: 'b' }, {}, {}, {}, {}]);
    renderGrid([a, b]);

    await userEvent.click(screen.getByRole('tab', { name: '1x1' }));

    expect(screen.getByTestId('tile-a')).toBeInTheDocument();
    expect(screen.queryByTestId('tile-b')).not.toBeInTheDocument();
    expect(screen.queryByTestId('empty-slot')).not.toBeInTheDocument();
  });

  it('degrades a binding to an empty slot when its session is gone (dead-session restore)', () => {
    seedPreference('2x1', [{ sessionId: 'ghost' }, {}]);
    // 'ghost' is not in the sessions list.
    renderGrid([]);

    expect(screen.queryByTestId('tile-ghost')).not.toBeInTheDocument();
    expect(screen.getAllByTestId('empty-slot')).toHaveLength(2);
  });

  it('maximize renders SessionDetail and unmounts the other tiles; restore brings them back', async () => {
    const a = fakeSession({ id: 'a', title: 'Alpha' });
    const b = fakeSession({ id: 'b', title: 'Bravo' });
    seedPreference('2x1', [{ sessionId: 'a' }, { sessionId: 'b' }]);
    renderGrid([a, b]);

    await userEvent.click(screen.getByRole('button', { name: 'maximize-a' }));

    // Only the maximized SessionDetail is present; every tile is gone from the DOM.
    expect(screen.getByTestId('session-detail')).toHaveTextContent('detail:Alpha');
    expect(screen.queryByTestId('tile-a')).not.toBeInTheDocument();
    expect(screen.queryByTestId('tile-b')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /restore grid/i }));

    expect(screen.queryByTestId('session-detail')).not.toBeInTheDocument();
    expect(screen.getByTestId('tile-a')).toBeInTheDocument();
    expect(screen.getByTestId('tile-b')).toBeInTheDocument();
  });

  it('binds the slot to the session returned by create (create -> bind seam)', async () => {
    const created = fakeSession({ id: 'new-1', title: 'Fresh' });
    const onCreate = vi.fn().mockResolvedValue(created);
    seedPreference('1x1', [{}]);
    const { rerender } = renderGrid([], { onCreate });

    await userEvent.click(screen.getByRole('button', { name: 'create-in-slot' }));

    expect(onCreate).toHaveBeenCalledWith(
      'hello from slot',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    );
    // The slot binding is the seam under test: the created id must be persisted.
    await waitFor(() => {
      const raw = JSON.parse(localStorage.getItem(GRID_PREFERENCE_STORAGE_KEY) ?? '{}');
      expect(raw.slots[0]?.sessionId).toBe('new-1');
    });

    // Once the session list catches up, the bound slot renders the live tile.
    rerender(gridElement([created], { onCreate }));
    expect(screen.getByTestId('tile-new-1')).toBeInTheDocument();
    expect(screen.queryByTestId('empty-slot')).not.toBeInTheDocument();
  });

  it('renders a remote tile for a machine-bound slot and degrades it when gone', async () => {
    seedPreference('2x1', [{ sessionId: 'r1', machineId: 'studio' }, {}]);
    renderGrid([]);

    expect(screen.getByTestId('remote-tile-studio-r1')).toBeInTheDocument();
    // Local dead-session degradation must not swallow machine-bound slots.
    expect(screen.getAllByTestId('empty-slot')).toHaveLength(1);

    await userEvent.click(screen.getByRole('button', { name: 'gone-r1' }));

    expect(screen.queryByTestId('remote-tile-studio-r1')).not.toBeInTheDocument();
    expect(screen.getAllByTestId('empty-slot')).toHaveLength(2);
    await waitFor(() => {
      const raw = JSON.parse(localStorage.getItem(GRID_PREFERENCE_STORAGE_KEY) ?? '{}');
      expect(raw.slots[0]).toEqual({});
    });
  });

  describe('keyboard shortcuts', () => {
    it('Cmd+N focuses slot N', () => {
      const a = fakeSession({ id: 'a', title: 'Alpha' });
      const b = fakeSession({ id: 'b', title: 'Bravo' });
      seedPreference('2x1', [{ sessionId: 'a' }, { sessionId: 'b' }]);
      renderGrid([a, b]);

      fireEvent.keyDown(window, { key: '2', metaKey: true });

      expect(screen.getByTestId('tile-b')).toHaveAttribute('data-focused', 'true');
      expect(screen.getByTestId('tile-a')).toHaveAttribute('data-focused', 'false');
    });

    it('Cmd+Enter maximizes the focused tile and Esc restores the grid', () => {
      const a = fakeSession({ id: 'a', title: 'Alpha' });
      const b = fakeSession({ id: 'b', title: 'Bravo' });
      seedPreference('2x1', [{ sessionId: 'a' }, { sessionId: 'b' }]);
      renderGrid([a, b]);

      fireEvent.keyDown(window, { key: '1', metaKey: true });
      fireEvent.keyDown(window, { key: 'Enter', metaKey: true });

      expect(screen.getByTestId('session-detail')).toHaveTextContent('detail:Alpha');
      expect(screen.queryByTestId('tile-b')).not.toBeInTheDocument();

      fireEvent.keyDown(window, { key: 'Escape' });

      expect(screen.queryByTestId('session-detail')).not.toBeInTheDocument();
      expect(screen.getByTestId('tile-a')).toBeInTheDocument();
      expect(screen.getByTestId('tile-b')).toBeInTheDocument();
    });

    it('ignores shortcuts while typing in a form field', () => {
      const a = fakeSession({ id: 'a', title: 'Alpha' });
      seedPreference('2x1', [{ sessionId: 'a' }, {}]);
      renderGrid([a]);

      fireEvent.keyDown(screen.getByLabelText('slot-input'), { key: '1', metaKey: true });

      expect(screen.getByTestId('tile-a')).toHaveAttribute('data-focused', 'false');
    });
  });

  it('persists a preset change to localStorage', async () => {
    seedPreference('2x2', [{}, {}, {}, {}]);
    renderGrid([]);
    await userEvent.click(screen.getByRole('tab', { name: '2x1' }));
    await waitFor(() => {
      const raw = JSON.parse(localStorage.getItem(GRID_PREFERENCE_STORAGE_KEY) ?? '{}');
      expect(raw.preset).toBe('2x1');
      expect(raw.slots).toHaveLength(2);
    });
  });
});
