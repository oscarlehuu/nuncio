import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../../lib/forge-api', () => ({
  fetchForgeIssue: vi.fn(),
  addForgeIssueComment: vi.fn(),
  setForgeIssueState: vi.fn(),
}));

import { IssueDetail } from './issue-detail';
import { addForgeIssueComment, fetchForgeIssue, setForgeIssueState } from '../../lib/forge-api';
import { clearForgeCache } from '../../lib/forge-cache';
import { takeComposerDraft } from '../../lib/composer-draft';

const ISSUE = {
  number: 12,
  title: 'Crash on save',
  state: 'open',
  author: 'someone',
  labels: ['bug'],
  assignees: [],
  commentCount: 1,
  updatedAt: '2026-07-02T08:00:00Z',
  url: 'https://github.com/o/r/issues/12',
  body: 'It crashes.',
  comments: [{ id: '1', author: 'oscar', body: 'me too', createdAt: '2026-07-02T09:00:00Z' }],
};

function renderIssue() {
  return render(
    <MemoryRouter>
      <IssueDetail path="/repo/worktree" number={12} projectPath="/repo" onBack={() => {}} />
    </MemoryRouter>,
  );
}

describe('IssueDetail', () => {
  beforeEach(() => {
    sessionStorage.clear();
    clearForgeCache();
    vi.mocked(fetchForgeIssue).mockReset().mockResolvedValue(ISSUE);
    vi.mocked(addForgeIssueComment).mockReset().mockResolvedValue({ ok: true });
    vi.mocked(setForgeIssueState).mockReset().mockResolvedValue({ ok: true });
  });

  it('renders the issue body, labels, and comments', async () => {
    renderIssue();
    expect(await screen.findByText('Crash on save')).toBeInTheDocument();
    expect(screen.getByText('It crashes.')).toBeInTheDocument();
    expect(screen.getByText('bug')).toBeInTheDocument();
    expect(screen.getByText('me too')).toBeInTheDocument();
  });

  it('posts a comment and refreshes', async () => {
    renderIssue();
    await screen.findByText('Crash on save');

    await userEvent.type(screen.getByPlaceholderText(/add a comment/i), 'on it');
    await userEvent.click(screen.getByRole('button', { name: /^comment$/i }));

    await waitFor(() =>
      expect(addForgeIssueComment).toHaveBeenCalledWith('/repo/worktree', 12, 'on it'),
    );
  });

  it('closes the issue from the detail view', async () => {
    renderIssue();
    await screen.findByText('Crash on save');

    await userEvent.click(screen.getByRole('button', { name: /close issue/i }));
    await waitFor(() =>
      expect(setForgeIssueState).toHaveBeenCalledWith('/repo/worktree', 12, 'closed'),
    );
  });

  it('start session saves a composer draft against the project root', async () => {
    renderIssue();
    await screen.findByText('Crash on save');

    await userEvent.click(screen.getByRole('button', { name: /start session/i }));

    const draft = takeComposerDraft();
    expect(draft?.projectPath).toBe('/repo');
    expect(draft?.prompt).toContain('Fix issue #12: Crash on save');
    expect(draft?.prompt).toContain('Closes #12');
  });
});
