import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { GitActionsButton } from './git-actions-button';
import { TooltipProvider } from './ui/tooltip';
import { commitSession, pushSession, openPullRequest } from '../lib/api';

vi.mock('sonner', () => ({
  toast: {
    loading: vi.fn(() => 'toast-1'),
    success: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../lib/api')>('../lib/api');
  return {
    ...actual,
    commitSession: vi.fn(),
    pushSession: vi.fn(),
    openPullRequest: vi.fn(),
  };
});

describe('GitActionsButton', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(commitSession).mockResolvedValue({ sha: 'abc1234', committed: true });
    vi.mocked(pushSession).mockResolvedValue({ pushed: true, remoteBranch: 'nuncio/s1' });
    vi.mocked(openPullRequest).mockResolvedValue({
      url: 'https://github.com/o/r/pull/7',
      number: 7,
      state: 'open',
    } as never);
  });

  async function openMenu() {
    await userEvent.click(screen.getByRole('button', { name: /git actions/i }));
  }

  it('runs Commit & push through the commit dialog in order', async () => {
    render(<TooltipProvider><GitActionsButton sessionId="s1" sessionStatus="IDLE" branch="nuncio/s1" /></TooltipProvider>);

    await openMenu();
    await userEvent.click(screen.getByRole('menuitem', { name: /commit & push/i }));
    await userEvent.type(await screen.findByPlaceholderText(/commit message/i), 'fix: tweak');
    await userEvent.click(screen.getByRole('button', { name: /^commit & push$/i }));

    await waitFor(() => expect(pushSession).toHaveBeenCalledWith('s1'));
    expect(commitSession).toHaveBeenCalledWith('s1', 'fix: tweak');
    expect(vi.mocked(commitSession).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(pushSession).mock.invocationCallOrder[0]!,
    );
    expect(openPullRequest).not.toHaveBeenCalled();
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
  });

  it('pushes directly without a dialog', async () => {
    render(<TooltipProvider><GitActionsButton sessionId="s1" sessionStatus="IDLE" branch="nuncio/s1" /></TooltipProvider>);

    await openMenu();
    await userEvent.click(screen.getByRole('menuitem', { name: /^push$/i }));

    await waitFor(() => expect(pushSession).toHaveBeenCalledWith('s1'));
    expect(commitSession).not.toHaveBeenCalled();
  });

  it('runs the full commit, push & PR chain in order', async () => {
    render(<TooltipProvider><GitActionsButton sessionId="s1" sessionStatus="IDLE" branch="nuncio/s1" /></TooltipProvider>);

    await openMenu();
    await userEvent.click(screen.getByRole('menuitem', { name: /commit, push & pr/i }));
    await userEvent.type(await screen.findByPlaceholderText(/commit message/i), 'feat: ship');
    await userEvent.click(screen.getByRole('button', { name: /commit, push & pr/i }));

    await waitFor(() => expect(openPullRequest).toHaveBeenCalledWith('s1'));
    expect(vi.mocked(pushSession).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(openPullRequest).mock.invocationCallOrder[0]!,
    );
  });

  it('stops the chain and reports the failing stage', async () => {
    vi.mocked(pushSession).mockRejectedValue(new Error('remote rejected'));
    render(<TooltipProvider><GitActionsButton sessionId="s1" sessionStatus="IDLE" branch="nuncio/s1" /></TooltipProvider>);

    await openMenu();
    await userEvent.click(screen.getByRole('menuitem', { name: /commit, push & pr/i }));
    await userEvent.type(await screen.findByPlaceholderText(/commit message/i), 'feat: ship');
    await userEvent.click(screen.getByRole('button', { name: /commit, push & pr/i }));

    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(openPullRequest).not.toHaveBeenCalled();
  });

  it('disables push and PR actions without a branch', async () => {
    render(<TooltipProvider><GitActionsButton sessionId="s1" sessionStatus="IDLE" branch={null} /></TooltipProvider>);

    await openMenu();
    expect(screen.getByRole('menuitem', { name: /^push$/i })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    expect(screen.getByRole('menuitem', { name: /open pr/i })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    // Commit alone stays available.
    expect(screen.getByRole('menuitem', { name: /^commit…$/i })).not.toHaveAttribute(
      'aria-disabled',
      'true',
    );
  });
});
