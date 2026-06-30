import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../lib/api', () => ({
  fetchGitStatus: vi.fn(),
  fetchGitDiff: vi.fn(),
  commitSession: vi.fn(),
  pushSession: vi.fn(),
}));

import { ReviewChanges } from './review-changes';
import {
  fetchGitStatus,
  fetchGitDiff,
  commitSession,
  pushSession,
} from '../lib/api';

const STATUS = {
  branch: 'nuncio/abc-fix',
  ahead: 0,
  behind: 0,
  clean: false,
  files: [
    { path: 'src/app.ts', index: 'M', workTree: ' ', staged: true },
  ],
};

const DIFF = {
  diff: 'diff --git a/src/app.ts b/src/app.ts\n+changed line\n',
  truncated: false,
};

describe('ReviewChanges', () => {
  beforeEach(() => {
    vi.mocked(fetchGitStatus).mockReset().mockResolvedValue(STATUS);
    vi.mocked(fetchGitDiff).mockReset().mockResolvedValue(DIFF);
    vi.mocked(commitSession).mockReset().mockResolvedValue({ sha: 'a'.repeat(40), committed: true });
    vi.mocked(pushSession).mockReset().mockResolvedValue({ pushed: true, remoteBranch: 'nuncio/abc-fix' });
  });

  it('renders the branch name and a changed file', async () => {
    render(<ReviewChanges sessionId="s1" />);
    await waitFor(() => expect(fetchGitStatus).toHaveBeenCalledWith('s1'));
    expect(await screen.findByText(/nuncio\/abc-fix/)).toBeInTheDocument();
    expect(await screen.findByText(/src\/app\.ts/)).toBeInTheDocument();
  });

  it('disables Commit when the message is empty', async () => {
    render(<ReviewChanges sessionId="s1" />);
    const commit = await screen.findByRole('button', { name: /commit/i });
    expect(commit).toBeDisabled();
  });

  it('commits with the typed message when Commit is clicked', async () => {
    render(<ReviewChanges sessionId="s1" />);
    await screen.findByText(/src\/app\.ts/);
    const input = screen.getByPlaceholderText(/message/i);
    await userEvent.type(input, 'Fix the bug');
    const commit = screen.getByRole('button', { name: /commit/i });
    expect(commit).toBeEnabled();
    await userEvent.click(commit);
    await waitFor(() =>
      expect(commitSession).toHaveBeenCalledWith('s1', 'Fix the bug', expect.anything()),
    );
  });

  it('pushes when the Push button is clicked', async () => {
    render(<ReviewChanges sessionId="s1" />);
    const push = await screen.findByRole('button', { name: /push/i });
    await userEvent.click(push);
    await waitFor(() => expect(pushSession).toHaveBeenCalledWith('s1', expect.anything()));
  });
});
