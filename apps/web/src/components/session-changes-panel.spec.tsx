import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { SessionChangesPanel } from './session-changes-panel';
import {
  commitSession,
  fetchCommitDiff,
  fetchGitBranchSync,
  fetchGitHistory,
  fetchGitStash,
  fetchSessionDiff,
  generateCommitMessage,
  openPullRequest,
  postDiffComment,
  pushSession,
  type GitBranchSyncDto,
  type SessionDiff,
} from '../lib/api';
import { fetchBranches } from '../lib/projects';

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
    fetchSessionDiff: vi.fn(),
    fetchGitBranchSync: vi.fn(),
    fetchGitStash: vi.fn(),
    fetchGitHistory: vi.fn(),
    fetchCommitDiff: vi.fn(),
    postDiffComment: vi.fn(),
    commitSession: vi.fn(),
    pushSession: vi.fn(),
    openPullRequest: vi.fn(),
    generateCommitMessage: vi.fn(),
  };
});

vi.mock('../lib/projects', () => ({
  fetchBranches: vi.fn(),
}));

const SYNC_CLEAN: GitBranchSyncDto = {
  branch: 'main',
  base: 'origin/main',
  ahead: 0,
  behind: 0,
  outgoing: [],
  incoming: [],
  conflicts: [],
  clean: true,
};

const DIFF: SessionDiff = {
  files: [
    {
      path: 'apps/web/src/app.tsx',
      oldPath: null,
      status: 'modified',
      additions: 3,
      deletions: 1,
      hunks: [
        {
          header: '@@ -10,2 +10,3 @@',
          oldStart: 10,
          oldLines: 2,
          newStart: 10,
          newLines: 3,
          lines: [
            { kind: 'context', text: 'const before = true;' },
            { kind: 'del', text: 'return before;' },
            { kind: 'add', text: 'return after;' },
          ],
        },
      ],
    },
    {
      path: 'bun.lock',
      oldPath: null,
      status: 'modified',
      additions: 250,
      deletions: 80,
      hunks: [],
      collapsed: 'lockfile',
    },
    {
      path: 'public/logo.png',
      oldPath: null,
      status: 'binary',
      additions: 0,
      deletions: 0,
      hunks: [],
      collapsed: 'binary',
    },
  ],
  truncated: true,
  omittedFiles: 2,
};

describe('SessionChangesPanel', () => {
  beforeEach(() => {
    vi.mocked(fetchSessionDiff).mockReset().mockResolvedValue(DIFF);
    vi.mocked(fetchGitBranchSync).mockReset().mockResolvedValue(SYNC_CLEAN);
    vi.mocked(fetchGitStash).mockReset().mockResolvedValue([]);
    vi.mocked(fetchGitHistory).mockReset().mockResolvedValue({ branch: 'main', commits: [] });
    vi.mocked(fetchCommitDiff).mockReset().mockResolvedValue({ diff: '@@ -1 +1 @@\n-old\n+new', truncated: false });
    vi.mocked(postDiffComment).mockReset().mockResolvedValue({ ok: true });
    vi.mocked(commitSession)
      .mockReset()
      .mockResolvedValue({ sha: 'abc1234', committed: true });
    vi.mocked(pushSession)
      .mockReset()
      .mockResolvedValue({ pushed: true, remoteBranch: 'nuncio/s1' });
    vi.mocked(openPullRequest)
      .mockReset()
      .mockResolvedValue({
        url: 'https://github.com/o/r/pull/7',
        number: 7,
        state: 'open',
      } as never);
    vi.mocked(generateCommitMessage)
      .mockReset()
      .mockResolvedValue({ message: 'feat: add greeting helper' });
    vi.mocked(toast.loading).mockReset().mockReturnValue('toast-1' as never);
    vi.mocked(fetchBranches).mockReset().mockResolvedValue([
      { name: 'main', isDefault: true, isCurrent: true },
      { name: 'feat/other', isDefault: false, isCurrent: false },
    ]);
    vi.mocked(toast.success).mockReset();
    vi.mocked(toast.error).mockReset();
  });

  describe('generated commit message', () => {
    it('fills the message box from the generate icon inside it', async () => {
      render(<SessionChangesPanel sessionId="s1" sessionStatus="IDLE" />);

      await screen.findByText('apps/web/src/app.tsx');
      await userEvent.click(screen.getByRole('button', { name: /generate commit message/i }));

      await waitFor(() => expect(generateCommitMessage).toHaveBeenCalledWith('s1'));
      await waitFor(() =>
        expect(screen.getByPlaceholderText(/commit message/i)).toHaveValue(
          'feat: add greeting helper',
        ),
      );
      // Generation only prefills — nothing commits without an explicit click.
      expect(commitSession).not.toHaveBeenCalled();
    });

    it('surfaces a generation failure as an error toast', async () => {
      vi.mocked(generateCommitMessage).mockRejectedValue(
        new Error('No available engine supports text generation'),
      );
      render(<SessionChangesPanel sessionId="s1" sessionStatus="IDLE" />);

      await screen.findByText('apps/web/src/app.tsx');
      await userEvent.click(screen.getByRole('button', { name: /generate commit message/i }));

      await waitFor(() =>
        expect(toast.error).toHaveBeenCalledWith('No available engine supports text generation'),
      );
    });
  });

  describe('commit section', () => {
    it('renders a commit box when there are changed files, disabled until a message is typed', async () => {
      render(<SessionChangesPanel sessionId="s1" sessionStatus="IDLE" />);

      expect(await screen.findByText('apps/web/src/app.tsx')).toBeInTheDocument();
      const commitButton = screen.getByRole('button', { name: /^commit$/i });
      expect(commitButton).toBeDisabled();

      await userEvent.type(screen.getByPlaceholderText(/commit message/i), 'fix: app tweak');
      expect(commitButton).toBeEnabled();
    });

    it('shows the commit box for staged-only changes (empty unstaged diff, dirty status)', async () => {
      vi.mocked(fetchSessionDiff).mockResolvedValue({ files: [], truncated: false, omittedFiles: 0 });
      vi.mocked(fetchGitBranchSync).mockResolvedValue({ ...SYNC_CLEAN, clean: false });
      render(<SessionChangesPanel sessionId="s1" sessionStatus="IDLE" />);

      expect(await screen.findByPlaceholderText(/commit message/i)).toBeInTheDocument();
      expect(screen.queryByText(/working tree clean/i)).not.toBeInTheDocument();
    });

    it('does not render the commit box when the working tree is clean', async () => {
      vi.mocked(fetchSessionDiff).mockResolvedValue({ files: [], truncated: false, omittedFiles: 0 });
      render(<SessionChangesPanel sessionId="s1" sessionStatus="IDLE" />);

      expect(await screen.findByText(/working tree clean|no local changes/i)).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /^commit$/i })).not.toBeInTheDocument();
    });

    it('commits with the typed message, clears it, and reloads changes', async () => {
      render(<SessionChangesPanel sessionId="s1" sessionStatus="IDLE" />);

      await screen.findByText('apps/web/src/app.tsx');
      const input = screen.getByPlaceholderText(/commit message/i);
      await userEvent.type(input, 'fix: app tweak');
      await userEvent.click(screen.getByRole('button', { name: /^commit$/i }));

      await waitFor(() => expect(commitSession).toHaveBeenCalledWith('s1', 'fix: app tweak'));
      await waitFor(() => expect(toast.success).toHaveBeenCalled());
      expect(input).toHaveValue('');
      // one load on mount + one reload after commit
      await waitFor(() => expect(fetchSessionDiff).toHaveBeenCalledTimes(2));
    });

    it('commits and pushes via the commit split menu in order', async () => {
      render(<SessionChangesPanel sessionId="s1" sessionStatus="IDLE" />);

      await screen.findByText('apps/web/src/app.tsx');
      await userEvent.type(screen.getByPlaceholderText(/commit message/i), 'fix: app tweak');
      await userEvent.click(screen.getByRole('button', { name: /more commit actions/i }));
      await userEvent.click(await screen.findByRole('menuitem', { name: /commit & push/i }));

      await waitFor(() => expect(pushSession).toHaveBeenCalledWith('s1'));
      expect(commitSession).toHaveBeenCalledWith('s1', 'fix: app tweak');
      expect(vi.mocked(commitSession).mock.invocationCallOrder[0]).toBeLessThan(
        vi.mocked(pushSession).mock.invocationCallOrder[0]!,
      );
      expect(openPullRequest).not.toHaveBeenCalled();
      await waitFor(() => expect(toast.success).toHaveBeenCalled());
      expect(screen.getByPlaceholderText(/commit message/i)).toHaveValue('');
    });

    it('runs commit, push & PR in order when the session is idle', async () => {
      render(<SessionChangesPanel sessionId="s1" sessionStatus="IDLE" />);

      await screen.findByText('apps/web/src/app.tsx');
      await userEvent.type(screen.getByPlaceholderText(/commit message/i), 'feat: ship');
      await userEvent.click(screen.getByRole('button', { name: /more commit actions/i }));
      await userEvent.click(await screen.findByRole('menuitem', { name: /commit, push & pr/i }));

      await waitFor(() => expect(openPullRequest).toHaveBeenCalledWith('s1'));
      expect(vi.mocked(pushSession).mock.invocationCallOrder[0]).toBeLessThan(
        vi.mocked(openPullRequest).mock.invocationCallOrder[0]!,
      );
    });

    it('disables the PR chain while the session is running', async () => {
      render(<SessionChangesPanel sessionId="s1" sessionStatus="RUNNING" />);

      await screen.findByText('apps/web/src/app.tsx');
      await userEvent.type(screen.getByPlaceholderText(/commit message/i), 'feat: ship');
      await userEvent.click(screen.getByRole('button', { name: /more commit actions/i }));
      expect(await screen.findByRole('menuitem', { name: /commit, push & pr/i })).toHaveAttribute(
        'aria-disabled',
        'true',
      );
      expect(screen.getByRole('menuitem', { name: /commit & push/i })).not.toHaveAttribute(
        'aria-disabled',
        'true',
      );
    });

    it('stops the chain and reports the failing stage', async () => {
      vi.mocked(pushSession).mockRejectedValue(new Error('remote rejected'));
      render(<SessionChangesPanel sessionId="s1" sessionStatus="IDLE" />);

      await screen.findByText('apps/web/src/app.tsx');
      await userEvent.type(screen.getByPlaceholderText(/commit message/i), 'feat: ship');
      await userEvent.click(screen.getByRole('button', { name: /more commit actions/i }));
      await userEvent.click(await screen.findByRole('menuitem', { name: /commit, push & pr/i }));

      await waitFor(() => expect(toast.error).toHaveBeenCalled());
      expect(openPullRequest).not.toHaveBeenCalled();
    });

    it('surfaces a commit failure as an error toast and keeps the message', async () => {
      vi.mocked(commitSession).mockRejectedValue(new Error('nothing to commit'));
      render(<SessionChangesPanel sessionId="s1" sessionStatus="IDLE" />);

      await screen.findByText('apps/web/src/app.tsx');
      const input = screen.getByPlaceholderText(/commit message/i);
      await userEvent.type(input, 'fix: app tweak');
      await userEvent.click(screen.getByRole('button', { name: /^commit$/i }));

      await waitFor(() => expect(toast.error).toHaveBeenCalledWith('nothing to commit'));
      expect(input).toHaveValue('fix: app tweak');
    });
  });

  it('fetches on open, renders files, and refreshes manually', async () => {
    render(<SessionChangesPanel sessionId="s1" sessionStatus="IDLE" />);

    expect(await screen.findByText('apps/web/src/app.tsx')).toBeInTheDocument();
    expect(screen.getAllByText('+3').length).toBeGreaterThan(0);
    expect(screen.getAllByText('-1').length).toBeGreaterThan(0);
    expect(screen.getByText(/2 files omitted/i)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /refresh changes/i }));
    await waitFor(() => expect(fetchSessionDiff).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(fetchGitBranchSync).toHaveBeenCalledTimes(2));
  });

  it('shows branch strip with push disabled when ahead is 0', async () => {
    render(<SessionChangesPanel sessionId="s1" sessionStatus="IDLE" />);

    expect(await screen.findByText('main')).toBeInTheDocument();
    const push = screen.getByRole('button', { name: /^push$/i });
    expect(push).toBeDisabled();
  });

  it('shows a calm empty state for clean sessions with branch strip', async () => {
    vi.mocked(fetchSessionDiff).mockResolvedValueOnce({ files: [], truncated: false, omittedFiles: 0 });
    render(<SessionChangesPanel sessionId="s1" sessionStatus="IDLE" />);
    expect(await screen.findByText(/no local changes/i)).toBeInTheDocument();
    expect(screen.getByText('main')).toBeInTheDocument();
  });

  it('lists outgoing commits even when the working tree is clean', async () => {
    vi.mocked(fetchSessionDiff).mockResolvedValueOnce({ files: [], truncated: false, omittedFiles: 0 });
    vi.mocked(fetchGitBranchSync).mockResolvedValueOnce({
      branch: 'feat/demo',
      base: 'origin/feat/demo',
      ahead: 2,
      behind: 0,
      outgoing: [
        {
          sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          shortSha: 'aaaaaaa',
          subject: 'feat: add demo panel',
          authorName: 'Oscar',
          authoredAt: '2026-07-13T01:00:00+00:00',
        },
        {
          sha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          shortSha: 'bbbbbbb',
          subject: 'chore: wire tests',
          authorName: 'Oscar',
          authoredAt: '2026-07-13T00:00:00+00:00',
        },
      ],
      incoming: [],
      conflicts: [],
      // Porcelain-clean: outgoing commits do not dirty the working tree (and a
      // dirty tree would now correctly surface the commit box instead).
      clean: true,
    });

    render(<SessionChangesPanel sessionId="s1" sessionStatus="IDLE" />);

    expect(await screen.findByText(/2 outgoing commits/i)).toBeInTheDocument();
    expect(screen.getByText('feat: add demo panel')).toBeInTheDocument();
    expect(screen.getByText('chore: wire tests')).toBeInTheDocument();
    expect(screen.getByText(/working tree clean/i)).toBeInTheDocument();
    expect(screen.queryByText(/no local changes/i)).toBeNull();
    expect(screen.getByRole('button', { name: /^push$/i })).toBeEnabled();
  });

  it('expands outgoing commit diff on click', async () => {
    vi.mocked(fetchSessionDiff).mockResolvedValueOnce({ files: [], truncated: false, omittedFiles: 0 });
    vi.mocked(fetchGitBranchSync).mockResolvedValueOnce({
      ...SYNC_CLEAN,
      branch: 'feat/demo',
      ahead: 1,
      clean: false,
      outgoing: [
        {
          sha: 'cccccccccccccccccccccccccccccccccccccccc',
          shortSha: 'ccccccc',
          subject: 'fix: panel layout',
          authorName: 'Oscar',
          authoredAt: '2026-07-13T02:00:00+00:00',
        },
      ],
    });

    render(<SessionChangesPanel sessionId="s1" sessionStatus="IDLE" />);

    await userEvent.click(await screen.findByRole('button', { name: /fix: panel layout/i }));
    await waitFor(() =>
      expect(fetchCommitDiff).toHaveBeenCalledWith('s1', 'cccccccccccccccccccccccccccccccccccccccc'),
    );
    expect(await screen.findByText('+new')).toBeInTheDocument();
  });

  it('shows conflicts banner when sync reports conflicted paths', async () => {
    vi.mocked(fetchSessionDiff).mockResolvedValueOnce({ files: [], truncated: false, omittedFiles: 0 });
    vi.mocked(fetchGitBranchSync).mockResolvedValueOnce({
      ...SYNC_CLEAN,
      clean: false,
      conflicts: ['src/conflicted.ts', 'README.md'],
    });

    render(<SessionChangesPanel sessionId="s1" sessionStatus="IDLE" />);

    expect(await screen.findByText(/2 merge conflicts/i)).toBeInTheDocument();
    expect(screen.getByText('src/conflicted.ts')).toBeInTheDocument();
    expect(screen.getByText('README.md')).toBeInTheDocument();
  });

  it('expands textual hunks but keeps collapsed and binary rows locked', async () => {
    render(<SessionChangesPanel sessionId="s1" sessionStatus="IDLE" />);

    await userEvent.click(await screen.findByRole('button', { name: /apps\/web\/src\/app.tsx/i }));
    expect(await screen.findByText('@@ -10,2 +10,3 @@')).toBeInTheDocument();
    expect(screen.getByText('+return after;')).toBeInTheDocument();

    expect(screen.getByText(/lockfile collapsed/i)).toBeInTheDocument();
    expect(screen.getByText(/binary file/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /bun\.lock/i })).toBeNull();
  });

  it('renders an added empty file as a quiet non-expandable row', async () => {
    vi.mocked(fetchSessionDiff).mockResolvedValueOnce({
      files: [
        {
          path: 'apps/web/src/empty-marker.ts',
          oldPath: null,
          status: 'added',
          additions: 0,
          deletions: 0,
          hunks: [],
        },
      ],
      truncated: false,
      omittedFiles: 0,
    });

    render(<SessionChangesPanel sessionId="s1" sessionStatus="IDLE" />);

    expect(await screen.findByText('apps/web/src/empty-marker.ts')).toBeInTheDocument();
    expect(screen.getByText('Empty file')).toBeInTheDocument();
    expect(screen.queryByText('Diff unavailable')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /empty-marker/i })).not.toBeInTheDocument();
  });

  it('sends an inline hunk comment and confirms without duplicating transcript text', async () => {
    render(<SessionChangesPanel sessionId="s1" sessionStatus="IDLE" />);

    await userEvent.click(await screen.findByRole('button', { name: /apps\/web\/src\/app.tsx/i }));
    await userEvent.click(screen.getByRole('button', { name: /comment on hunk/i }));
    const send = screen.getByRole('button', { name: /^send$/i });
    expect(send).toBeDisabled();

    await userEvent.type(screen.getByPlaceholderText(/tell the agent/i), 'Please simplify this.');
    expect(send).toBeEnabled();
    await userEvent.click(send);

    await waitFor(() =>
      expect(postDiffComment).toHaveBeenCalledWith('s1', {
        path: 'apps/web/src/app.tsx',
        startLine: 10,
        endLine: 12,
        hunk: '@@ -10,2 +10,3 @@\n const before = true;\n-return before;\n+return after;',
        comment: 'Please simplify this.',
      }),
    );
    expect(screen.queryByPlaceholderText(/tell the agent/i)).toBeNull();
    expect(screen.getByText(/sent to agent/i)).toBeInTheDocument();
    expect(toast.success).toHaveBeenCalledWith('Sent to agent');
  });

  it('notes queued delivery when commenting while the session is running', async () => {
    render(<SessionChangesPanel sessionId="s1" sessionStatus="RUNNING" />);

    await userEvent.click(await screen.findByRole('button', { name: /apps\/web\/src\/app.tsx/i }));
    await userEvent.click(screen.getByRole('button', { name: /comment on hunk/i }));
    await userEvent.type(screen.getByPlaceholderText(/tell the agent/i), 'Use the existing helper.');
    await userEvent.click(screen.getByRole('button', { name: /^send$/i }));

    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith('Sent to agent — queued for the running session'),
    );
  });

  it('keeps the composer open and shows a toast when comment submit fails', async () => {
    vi.mocked(postDiffComment).mockRejectedValueOnce(new Error('No workspace'));
    render(<SessionChangesPanel sessionId="s1" sessionStatus="IDLE" />);

    await userEvent.click(await screen.findByRole('button', { name: /apps\/web\/src\/app.tsx/i }));
    await userEvent.click(screen.getByRole('button', { name: /comment on hunk/i }));
    await userEvent.type(screen.getByPlaceholderText(/tell the agent/i), 'Try again.');
    await userEvent.click(screen.getByRole('button', { name: /^send$/i }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('No workspace'));
    expect(screen.getByPlaceholderText(/tell the agent/i)).toBeInTheDocument();
  });

  it('reloads history when a different branch is selected', async () => {
    vi.mocked(fetchSessionDiff).mockResolvedValue({ files: [], truncated: false, omittedFiles: 0 });
    vi.mocked(fetchGitHistory).mockImplementation(async (_id, opts) => {
      const branch =
        typeof opts === 'object' && opts?.branch ? opts.branch : 'main';
      if (branch === 'feat/other') {
        return {
          branch: 'feat/other',
          commits: [
            {
              sha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
              shortSha: 'bbbbbbb',
              subject: 'work on other',
              authorName: 'Oscar',
              authoredAt: '2026-07-13T01:00:00+00:00',
              parents: ['aaaaaaa'],
            },
          ],
        };
      }
      return {
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
      };
    });

    render(
      <SessionChangesPanel sessionId="s1" sessionStatus="IDLE" repoPath="/repo" branch="main" />,
    );

    expect(await screen.findByText('init on main')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /history branch/i }));
    await userEvent.click(await screen.findByRole('option', { name: /feat\/other/i }));

    await waitFor(() =>
      expect(fetchGitHistory).toHaveBeenCalledWith('s1', { limit: 15, branch: 'feat/other' }),
    );
    expect(await screen.findByText('work on other')).toBeInTheDocument();
    expect(fetchBranches).toHaveBeenCalled();
  });
});
