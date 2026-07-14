// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { clearForgeCache } from '../../lib/forge-cache';

vi.mock('../../lib/forge-api', () => ({ fetchForgePulls: vi.fn() }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { PrList } from './pr-list';
import { fetchForgePulls, type ForgePullRequestSummary } from '../../lib/forge-api';

const REPO = '/Users/me/nuncio';

function makePr(partial: Partial<ForgePullRequestSummary> = {}): ForgePullRequestSummary {
  return {
    number: 1,
    title: 'Fix forge list',
    state: 'open',
    draft: false,
    author: 'octo',
    sourceBranch: 'feat/forge',
    targetBranch: 'main',
    url: 'https://github.com/octo/nuncio/pull/1',
    updatedAt: '2026-01-01T00:00:00Z',
    commentCount: 0,
    ...partial,
  };
}

describe('PrList', () => {
  beforeEach(() => {
    clearForgeCache();
    vi.mocked(fetchForgePulls).mockReset();
  });

  it('shows loading then open pull requests', async () => {
    vi.mocked(fetchForgePulls).mockResolvedValue([
      makePr({ number: 12, title: 'Open PR', state: 'open', commentCount: 2 }),
    ]);
    render(<PrList path={REPO} onOpen={vi.fn()} />);

    expect(screen.getByText('Loading pull requests…')).toBeInTheDocument();
    expect(await screen.findByText('Open PR')).toBeInTheDocument();
    expect(screen.getByText('#12')).toBeInTheDocument();
    expect(fetchForgePulls).toHaveBeenCalledWith(REPO, 'open');
  });

  it('filters merged and closed tabs client-side', async () => {
    vi.mocked(fetchForgePulls).mockResolvedValue([
      makePr({ number: 1, title: 'Still open', state: 'open' }),
      makePr({ number: 2, title: 'Was merged', state: 'merged' }),
      makePr({ number: 3, title: 'Was closed', state: 'closed' }),
    ]);
    const user = userEvent.setup();
    render(<PrList path={REPO} onOpen={vi.fn()} />);

    await screen.findByText('Still open');
    expect(screen.queryByText('Was merged')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'merged' }));
    expect(await screen.findByText('Was merged')).toBeInTheDocument();
    expect(screen.queryByText('Still open')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'closed' }));
    expect(await screen.findByText('Was closed')).toBeInTheDocument();
  });

  it('calls onOpen when a row is clicked', async () => {
    vi.mocked(fetchForgePulls).mockResolvedValue([
      makePr({ number: 99, title: 'Click me', state: 'open' }),
    ]);
    const onOpen = vi.fn();
    const user = userEvent.setup();
    render(<PrList path={REPO} onOpen={onOpen} />);

    await user.click(await screen.findByText('Click me'));
    expect(onOpen).toHaveBeenCalledWith(99);
  });

  it('shows empty state for a tab with no matching PRs', async () => {
    vi.mocked(fetchForgePulls).mockResolvedValue([makePr({ state: 'open' })]);
    const user = userEvent.setup();
    render(<PrList path={REPO} onOpen={vi.fn()} />);

    await screen.findByText(/#/);
    await user.click(screen.getByRole('button', { name: 'merged' }));
    expect(await screen.findByText('No merged pull requests.')).toBeInTheDocument();
  });

  it('toasts fetch errors on initial load', async () => {
    const { toast } = await import('sonner');
    vi.mocked(fetchForgePulls).mockRejectedValue(new Error('Forge offline'));
    render(<PrList path={REPO} onOpen={vi.fn()} />);

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('Forge offline'),
    );
  });
});
