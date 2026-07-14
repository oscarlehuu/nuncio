// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { clearForgeCache } from '../../lib/forge-cache';

vi.mock('../../lib/forge-api', () => ({ fetchForgeIssues: vi.fn() }));
vi.mock('../../lib/forge-status-api', () => ({ fetchForgeStatus: vi.fn() }));
vi.mock('./new-issue-dialog', () => ({
  NewIssueDialog: ({
    open,
    onOpenChange,
    onCreated,
  }: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onCreated: (number: number) => void;
  }) =>
    open ? (
      <div>
        <span>New issue dialog</span>
        <button type="button" onClick={() => onOpenChange(false)}>
          Close dialog
        </button>
        <button type="button" onClick={() => onCreated(101)}>
          Mock create
        </button>
      </div>
    ) : null,
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { IssueList } from './issue-list';
import { fetchForgeIssues, type ForgeIssueSummary } from '../../lib/forge-api';
import { fetchForgeStatus } from '../../lib/forge-status-api';

const REPO = '/Users/me/nuncio';

function makeIssue(partial: Partial<ForgeIssueSummary> = {}): ForgeIssueSummary {
  return {
    number: 7,
    title: 'Bug report',
    state: 'open',
    author: 'octo',
    labels: ['bug'],
    assignees: [],
    commentCount: 0,
    updatedAt: '2026-01-01T00:00:00Z',
    url: 'https://github.com/octo/nuncio/issues/7',
    ...partial,
  };
}

describe('IssueList', () => {
  beforeEach(() => {
    clearForgeCache();
    vi.mocked(fetchForgeIssues).mockReset();
    vi.mocked(fetchForgeStatus).mockReset();
    vi.mocked(fetchForgeStatus).mockResolvedValue([
      { id: 'github', name: 'GitHub', connected: true, login: 'octo', method: 'cli', reason: null },
    ]);
  });

  it('shows loading then open issues', async () => {
    vi.mocked(fetchForgeIssues).mockResolvedValue([
      makeIssue({ number: 42, title: 'Fix pairing', commentCount: 3 }),
    ]);
    render(<IssueList path={REPO} onOpen={vi.fn()} />);

    expect(screen.getByText('Loading issues…')).toBeInTheDocument();
    expect(await screen.findByText('Fix pairing')).toBeInTheDocument();
    expect(screen.getByText('#42')).toBeInTheDocument();
    expect(fetchForgeIssues).toHaveBeenCalledWith(REPO, 'open');
  });

  it('switches to closed issues', async () => {
    vi.mocked(fetchForgeIssues).mockImplementation((_path, state) =>
      Promise.resolve(
        state === 'closed'
          ? [makeIssue({ number: 2, title: 'Closed issue', state: 'closed' })]
          : [makeIssue({ number: 1, title: 'Open issue', state: 'open' })],
      ),
    );
    const user = userEvent.setup();
    render(<IssueList path={REPO} onOpen={vi.fn()} />);

    await screen.findByText('Open issue');
    await user.click(screen.getByRole('button', { name: 'closed' }));
    expect(await screen.findByText('Closed issue')).toBeInTheDocument();
    expect(screen.queryByText('Open issue')).not.toBeInTheDocument();
  });

  it('filters mine to assignees and author matching login', async () => {
    vi.mocked(fetchForgeIssues).mockResolvedValue([
      makeIssue({ number: 1, title: 'Mine', assignees: ['octo'] }),
      makeIssue({ number: 2, title: 'Theirs', author: 'other', assignees: ['other'] }),
      makeIssue({ number: 3, title: 'Authored', author: 'octo', assignees: [] }),
    ]);
    const user = userEvent.setup();
    render(<IssueList path={REPO} onOpen={vi.fn()} />);

    await screen.findByText('Mine');
    await user.click(screen.getByRole('button', { name: 'mine' }));
    expect(await screen.findByText('Authored')).toBeInTheDocument();
    expect(screen.queryByText('Theirs')).not.toBeInTheDocument();
  });

  it('opens the new issue dialog and routes created issues', async () => {
    vi.mocked(fetchForgeIssues).mockResolvedValue([]);
    const onOpen = vi.fn();
    const user = userEvent.setup();
    render(<IssueList path={REPO} onOpen={onOpen} />);

    await screen.findByText('No issues found.');
    await user.click(screen.getByRole('button', { name: /new issue/i }));
    expect(screen.getByText('New issue dialog')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Mock create' }));
    expect(onOpen).toHaveBeenCalledWith(101);
  });

  it('toasts fetch errors on initial load', async () => {
    const { toast } = await import('sonner');
    vi.mocked(fetchForgeIssues).mockRejectedValue(new Error('Issues unavailable'));
    render(<IssueList path={REPO} onOpen={vi.fn()} />);

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('Issues unavailable'),
    );
  });
});
