import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import type { ComponentProps } from 'react';

vi.mock('../../lib/forge-api', () => ({
  fetchForgeCapabilities: vi.fn(),
  fetchForgePull: vi.fn(),
  fetchForgeThreads: vi.fn(),
  fetchForgePullComments: vi.fn(),
  setForgePullState: vi.fn(),
  addForgePullComment: vi.fn(),
  replyForgeThread: vi.fn(),
  resolveForgeThread: vi.fn(),
  submitForgeReview: vi.fn(),
  mergeForgePull: vi.fn(),
  updateForgeBranch: vi.fn(),
  fetchForgePullFiles: vi.fn(),
}));

import { PrDetail } from './pr-detail';
import { clearForgeCache } from '../../lib/forge-cache';
import {
  fetchForgeCapabilities,
  fetchForgePull,
  fetchForgeThreads,
  fetchForgePullComments,
  replyForgeThread,
  fetchForgePullFiles,
} from '../../lib/forge-api';
import type {
  ForgeCapabilitiesDto,
  ForgeComment,
  ForgePullRequestDetail,
  ForgeReviewThread,
} from '../../lib/forge-api';

const GITHUB_CAPS: ForgeCapabilitiesDto = {
  provider: 'github',
  connected: true,
  authMethod: 'cli',
  requestChanges: true,
  rebaseMerge: true,
  mergeWhenChecksPass: false,
  resolveThreads: true,
  updateBranch: true,
  rerunFailedOnly: true,
  listRepositories: true,
};

const DETAIL: ForgePullRequestDetail = {
  number: 7,
  url: 'https://github.com/o/r/pull/7',
  state: 'open',
  title: 'Improve parsing',
  body: 'This PR improves parsing.',
  author: 'oscar',
  draft: false,
  sourceBranch: 'nuncio/abc-parse',
  targetBranch: 'main',
  mergeable: 'mergeable',
  reviewDecision: 'changes_requested',
  additions: 10,
  deletions: 2,
  changedFiles: 2,
  checks: [{ name: 'build', status: 'completed', conclusion: 'success' }],
};

const THREAD: ForgeReviewThread = {
  id: 'T1',
  replyTargetId: '99',
  resolved: false,
  resolvable: true,
  path: 'src/parse.ts',
  line: 4,
  outdated: false,
  comments: [{ id: '99', author: 'reviewer', body: 'simplify this', createdAt: '2026-07-01T00:00:00Z' }],
};

const COMMENTS: ForgeComment[] = [
  {
    id: 'c1',
    author: 'devin-bot',
    body: 'First conversation note with ![shot](https://example.com/a.png)',
    createdAt: '2026-07-19T12:00:00Z',
  },
  {
    id: 'c2',
    author: 'oscar',
    body: 'Second conversation note',
    createdAt: '2026-07-19T13:00:00Z',
  },
];

function renderPr(props: ComponentProps<typeof PrDetail>) {
  return render(
    <MemoryRouter>
      <PrDetail {...props} />
    </MemoryRouter>,
  );
}

describe('PrDetail', () => {
  beforeEach(() => {
    clearForgeCache();
    vi.mocked(fetchForgePull).mockReset().mockResolvedValue(DETAIL);
    vi.mocked(fetchForgeThreads).mockReset().mockResolvedValue([THREAD]);
    vi.mocked(fetchForgePullComments).mockReset().mockResolvedValue(COMMENTS);
    vi.mocked(fetchForgeCapabilities).mockReset().mockResolvedValue(GITHUB_CAPS);
    vi.mocked(replyForgeThread).mockReset().mockResolvedValue({ ok: true });
    vi.mocked(fetchForgePullFiles).mockReset().mockResolvedValue([]);
  });

  it('renders header, body, conversation comments, review decision, and the open thread', async () => {
    renderPr({ path: "/repo", number: 7 });

    expect(await screen.findByText('Improve parsing')).toBeInTheDocument();
    expect(screen.getByText(/changes requested/i)).toBeInTheDocument();
    expect(screen.getByText('This PR improves parsing.')).toBeInTheDocument();
    expect(await screen.findByText('devin-bot')).toBeInTheDocument();
    expect(screen.getByText(/First conversation note/)).toBeInTheDocument();
    expect(screen.getByText('Second conversation note')).toBeInTheDocument();
    expect(screen.getAllByText('oscar').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('src/parse.ts:4')).toBeInTheDocument();
    expect(screen.getByText('simplify this')).toBeInTheDocument();
    expect(fetchForgePullComments).toHaveBeenCalledWith('/repo', 7);
  });

  it('replies to a review thread', async () => {
    renderPr({ path: "/repo", number: 7 });
    await screen.findByText('simplify this');

    await userEvent.type(screen.getByPlaceholderText('Reply…'), 'done in latest commit');
    await userEvent.click(screen.getByRole('button', { name: /^reply$/i }));

    await waitFor(() =>
      expect(replyForgeThread).toHaveBeenCalledWith('/repo', 7, '99', 'done in latest commit'),
    );
  });

  it('disables request-changes when the forge lacks the capability', async () => {
    vi.mocked(fetchForgeCapabilities).mockResolvedValue({
      ...GITHUB_CAPS,
      provider: 'gitlab',
      requestChanges: false,
    });
    renderPr({ path: "/repo", number: 7 });
    await screen.findByText('Improve parsing');

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /request changes/i })).toBeDisabled(),
    );
    expect(screen.getByRole('button', { name: /approve/i })).toBeEnabled();
  });

  it('loads changed files on the Files tab', async () => {
    vi.mocked(fetchForgePullFiles).mockResolvedValue([
      { path: 'src/parse.ts', oldPath: null, status: 'modified', additions: 5, deletions: 1, patch: '@@ -1 +1 @@' },
    ]);
    renderPr({ path: "/repo", number: 7 });
    await screen.findByText('Improve parsing');

    await userEvent.click(screen.getByRole('button', { name: /files \(2\)/i }));
    expect(await screen.findByText('src/parse.ts')).toBeInTheDocument();
    expect(fetchForgePullFiles).toHaveBeenCalledWith('/repo', 7);
  });
});
