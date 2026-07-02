import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import type { Session } from '../lib/api';

const apiMocks = vi.hoisted(() => ({
  fetchSession: vi.fn(),
  steerSession: vi.fn(),
}));
vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../lib/api')>('../lib/api');
  return { ...actual, fetchSession: apiMocks.fetchSession, steerSession: apiMocks.steerSession };
});

// The tile itself is covered by its own spec — here only the remote wrapper's
// data path (poll, unreachable, gone) is under test.
vi.mock('./session-tile', () => ({
  SessionTile: ({ session, apiBase }: { session: Session; apiBase?: string }) => (
    <div data-testid="session-tile" data-api-base={apiBase}>
      {session.title}
    </div>
  ),
}));

import { RemoteSessionTile } from './remote-session-tile';

function fakeSession(over: Partial<Session> = {}): Session {
  return {
    id: 'r1',
    title: 'Remote run',
    status: 'RUNNING',
    provider: 'pi',
    model: null,
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

function renderTile(over: { onGone?: () => void } = {}) {
  return render(
    <RemoteSessionTile
      machineId="studio"
      sessionId="r1"
      focused={false}
      onFocus={vi.fn()}
      onGone={over.onGone ?? vi.fn()}
    />,
  );
}

describe('RemoteSessionTile', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('loads the session from the machine base and renders the tile against it', async () => {
    apiMocks.fetchSession.mockResolvedValue(fakeSession());
    renderTile();

    const tile = await screen.findByTestId('session-tile');
    expect(tile).toHaveTextContent('Remote run');
    expect(tile.getAttribute('data-api-base')).toContain('/m/studio');
    expect(apiMocks.fetchSession).toHaveBeenCalledWith('r1', expect.stringContaining('/m/studio'));
  });

  it('shows a reconnect state when the machine is unreachable, not an empty slot', async () => {
    apiMocks.fetchSession.mockRejectedValue(new Error('Failed to load session'));
    const onGone = vi.fn();
    renderTile({ onGone });

    expect(await screen.findByText(/unreachable — retrying/i)).toBeInTheDocument();
    expect(onGone).not.toHaveBeenCalled();
  });

  it('degrades to an empty slot when the session is gone for good (404)', async () => {
    apiMocks.fetchSession.mockRejectedValue(new Error('Not Found (404)'));
    const onGone = vi.fn();
    renderTile({ onGone });

    await waitFor(() => expect(onGone).toHaveBeenCalled());
  });
});
