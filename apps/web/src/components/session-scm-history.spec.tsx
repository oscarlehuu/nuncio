import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SessionScmHistory } from './session-scm-history';
import { fetchBranches } from '../lib/projects';

vi.mock('../lib/projects', () => ({
  fetchBranches: vi.fn(),
}));

describe('SessionScmHistory', () => {
  beforeEach(() => {
    vi.mocked(fetchBranches).mockReset().mockResolvedValue([
      { name: 'main', isDefault: true, isCurrent: true },
      { name: 'feat/other', isDefault: false, isCurrent: false },
      { name: 'origin/develop', isDefault: false, isCurrent: false },
    ]);
  });

  it('lets the user pick any branch to view history', async () => {
    const onBranchChange = vi.fn();
    render(
      <SessionScmHistory
        history={{
          branch: 'main',
          commits: [
            {
              sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
              shortSha: 'aaaaaaa',
              subject: 'init on main',
              authorName: 'Oscar',
              authoredAt: '2026-07-13T00:00:00+00:00',
              parents: [],
            },
          ],
        }}
        repoPath="/repo"
        selectedBranch="main"
        onBranchChange={onBranchChange}
      />,
    );

    expect(screen.getByText('Recent history')).toBeInTheDocument();
    expect(screen.getByText('init on main')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /history branch/i }));
    await userEvent.click(await screen.findByRole('option', { name: /feat\/other/i }));

    expect(onBranchChange).toHaveBeenCalledWith('feat/other');
  });

  it('shows an empty state when the selected branch has no commits', async () => {
    render(
      <SessionScmHistory
        history={{ branch: 'feat/empty', commits: [] }}
        repoPath="/repo"
        selectedBranch="feat/empty"
        onBranchChange={() => undefined}
      />,
    );

    expect(await screen.findByText(/no commits on this branch/i)).toBeInTheDocument();
    await waitFor(() => expect(fetchBranches).toHaveBeenCalledWith('/repo', '', { refresh: false }));
  });
});
