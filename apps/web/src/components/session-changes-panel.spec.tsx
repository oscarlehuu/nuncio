import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { SessionChangesPanel } from './session-changes-panel';
import {
  fetchSessionDiff,
  postDiffComment,
  type SessionDiff,
} from '../lib/api';

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../lib/api')>('../lib/api');
  return {
    ...actual,
    fetchSessionDiff: vi.fn(),
    postDiffComment: vi.fn(),
  };
});

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
    vi.mocked(postDiffComment).mockReset().mockResolvedValue({ ok: true });
    vi.mocked(toast.success).mockReset();
    vi.mocked(toast.error).mockReset();
  });

  it('fetches on open, renders files, and refreshes manually', async () => {
    render(<SessionChangesPanel sessionId="s1" sessionStatus="IDLE" />);

    expect(await screen.findByText('apps/web/src/app.tsx')).toBeInTheDocument();
    expect(screen.getAllByText('+3').length).toBeGreaterThan(0);
    expect(screen.getAllByText('-1').length).toBeGreaterThan(0);
    expect(screen.getByText(/2 files omitted/i)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /refresh changes/i }));
    await waitFor(() => expect(fetchSessionDiff).toHaveBeenCalledTimes(2));
  });

  it('shows a calm empty state for clean or non-git sessions', async () => {
    vi.mocked(fetchSessionDiff).mockResolvedValueOnce({ files: [], truncated: false, omittedFiles: 0 });
    render(<SessionChangesPanel sessionId="s1" sessionStatus="IDLE" />);
    expect(await screen.findByText(/no changes yet/i)).toBeInTheDocument();
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
});
