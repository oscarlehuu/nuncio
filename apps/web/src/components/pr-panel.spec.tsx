import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../lib/api', () => ({
  openPullRequest: vi.fn(),
  fetchPullRequest: vi.fn(),
}));

import { PrPanel } from './pr-panel';
import { openPullRequest, fetchPullRequest } from '../lib/api';
import type { Session } from '../lib/api';

const BASE_SESSION: Session = {
  id: 's1',
  title: 'Add a feature',
  status: 'IDLE',
  provider: 'pi',
  model: null,
  modelOptions: null,
  prompt: 'Add a feature so users can do the thing',
  preview: null,
  workspace: null,
  projectPath: '/repo',
  baseBranch: 'main',
  worktreePath: '/repo',
  branch: 'nuncio/abc-feature',
  cursorBackend: null,
  cursorChatId: null,
  createdAt: 0,
  updatedAt: 0,
};

const PR = {
  number: 42,
  url: 'https://github.com/octo/nuncio/pull/42',
  state: 'open',
  title: 'Add a feature',
  checks: [{ name: 'build', status: 'completed', conclusion: 'success' }],
};

describe('PrPanel', () => {
  beforeEach(() => {
    vi.mocked(openPullRequest).mockReset().mockResolvedValue(PR);
    vi.mocked(fetchPullRequest).mockReset().mockResolvedValue(PR);
  });

  it('enables Open Pull Request when the session is IDLE and has a branch', () => {
    render(<PrPanel session={BASE_SESSION} />);
    const button = screen.getByRole('button', { name: /open pull request/i });
    expect(button).toBeEnabled();
  });

  it('disables Open Pull Request when the session is not IDLE', () => {
    render(<PrPanel session={{ ...BASE_SESSION, status: 'RUNNING' }} />);
    const button = screen.getByRole('button', { name: /open pull request/i });
    expect(button).toBeDisabled();
  });

  it('disables Open Pull Request when the session has no branch', () => {
    render(<PrPanel session={{ ...BASE_SESSION, branch: null }} />);
    const button = screen.getByRole('button', { name: /open pull request/i });
    expect(button).toBeDisabled();
  });

  it('calls openPullRequest with the session id when clicked', async () => {
    render(<PrPanel session={BASE_SESSION} />);
    const button = screen.getByRole('button', { name: /open pull request/i });
    await userEvent.click(button);
    await waitFor(() => expect(openPullRequest).toHaveBeenCalledWith('s1', expect.anything()));
  });

  it('renders the PR url link, state badge, and a check after opening', async () => {
    render(<PrPanel session={BASE_SESSION} />);
    await userEvent.click(screen.getByRole('button', { name: /open pull request/i }));

    const link = await screen.findByRole('link', { name: /pull\/42/i });
    expect(link).toHaveAttribute('href', 'https://github.com/octo/nuncio/pull/42');
    expect(screen.getByText(/open/i)).toBeInTheDocument();
    expect(await screen.findByText(/build/i)).toBeInTheDocument();
  });
});
