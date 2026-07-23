import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import userEvent from '@testing-library/user-event';

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../lib/api')>('../lib/api');
  return {
    ...actual,
    fetchLoops: vi.fn(),
    fetchLoopRuns: vi.fn(),
    fetchLoopStats: vi.fn(),
    fetchAttention: vi.fn(),
    approveDispatcherProposal: vi.fn(),
    pauseLoop: vi.fn(),
    resumeLoop: vi.fn(),
    deleteLoop: vi.fn(),
  };
});

// Toasts are noise in jsdom; stub sonner so the view mounts clean.
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
// The project picker (in the create dialog) hits the network; keep it inert.
vi.mock('./project-picker', () => ({ ProjectPicker: () => <button type="button">pick</button> }));

import { AutopilotView } from './autopilot-view';
import { AttentionQueue } from './attention-queue';
import {
  deleteLoop,
  approveDispatcherProposal,
  fetchAttention,
  fetchLoopRuns,
  fetchLoops,
  fetchLoopStats,
  pauseLoop,
  resumeLoop,
  type LoopDto,
  type AttentionItemDto,
} from '../lib/api';
import { toast } from 'sonner';

function renderView(ui: ReactElement = <AutopilotView onBack={vi.fn()} providers={[]} />) {
  return render(<MemoryRouter>{ui}</MemoryRouter>);
}

const STATS = {
  total: 1,
  active: 1,
  broken: 0,
  successful7d: 0,
  failed7d: 0,
  successful24h: 0,
  failed24h: 0,
  sparkline: [],
};

function loop(partial: Partial<LoopDto>): LoopDto {
  return {
    id: partial.id ?? 'l1',
    name: partial.name ?? null,
    goal: partial.goal ?? 'Triage new issues',
    scheduleId: 'sch-1',
    schedule: 'schedule' in partial ? partial.schedule : { kind: 'cron', spec: 'daily@22:00' },
    nextFireAt: 'nextFireAt' in partial ? partial.nextFireAt : Date.now() + 2 * 3_600_000,
    maxRunsPerDay: partial.maxRunsPerDay ?? 24,
    maxConsecutiveFailures: 3,
    stop: partial.stop ?? null,
    escalation: 'needs-attention',
    projectPath: partial.projectPath ?? '/Users/me/nuncio',
    status: partial.status ?? 'active',
    createdAt: 0,
    updatedAt: 0,
  };
}

function dispatcherProposal(
  payload: Record<string, unknown>,
  partial: Partial<AttentionItemDto> = {},
): AttentionItemDto {
  return {
    id: partial.id ?? 'proposal-1',
    kind: 'dispatcher-proposal',
    subjectId: partial.subjectId ?? 'dispatch:2026-07-23',
    projectPath: null,
    severity: 10,
    title: "Tomorrow's plan",
    payload,
    status: 'open',
    acknowledgedAt: null,
    createdAt: partial.createdAt ?? 1,
    updatedAt: partial.updatedAt ?? partial.createdAt ?? 1,
    resolvedAt: null,
  };
}

function proposal(
  title: string,
  rationale: string,
  subjectKey = `subject:${title}`,
): Record<string, unknown> {
  return {
    subjectKey,
    title,
    prompt: `Run ${title}`,
    projectPath: '/Users/me/nuncio',
    rationale,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('AutopilotView', () => {
  beforeEach(() => {
    vi.mocked(toast.success).mockReset();
    vi.mocked(toast.error).mockReset();
    vi.mocked(fetchLoopRuns).mockReset().mockResolvedValue([]);
    vi.mocked(fetchLoops).mockReset();
    vi.mocked(fetchLoopStats).mockReset().mockResolvedValue(STATS);
    vi.mocked(fetchAttention).mockReset().mockResolvedValue({
      items: [],
      counts: { total: 0, unacked: 0, bySeverity: {} },
    });
    vi.mocked(approveDispatcherProposal).mockReset().mockResolvedValue({
      proposalId: 'proposal-1',
      taskIds: ['task-1', 'task-2'],
    });
    vi.mocked(pauseLoop).mockReset().mockResolvedValue(loop({ status: 'paused' }));
    vi.mocked(resumeLoop).mockReset().mockResolvedValue(loop({ status: 'active' }));
    vi.mocked(deleteLoop).mockReset().mockResolvedValue(undefined);
  });

  it('shows the empty state explaining a standing task plus a create button', async () => {
    vi.mocked(fetchLoops).mockResolvedValue([]);
    renderView();
    await waitFor(() => expect(screen.getByText('No standing tasks yet')).toBeInTheDocument());
    expect(screen.getByText(/a standing task is work nuncio runs on a schedule/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /create your first standing task/i })).toBeInTheDocument();
  });

  it('renders the fleet stat tiles even with zero loops (Cursor-parity)', async () => {
    vi.mocked(fetchLoops).mockResolvedValue([]);
    renderView();
    await waitFor(() => expect(screen.getByText('No standing tasks yet')).toBeInTheDocument());
    // The dashboard frame is present alongside the empty state, not gated behind loops.
    expect(screen.getByText('Standing tasks')).toBeInTheDocument();
    expect(screen.getByText('Successful · 7d')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /view all run history/i })).toBeInTheDocument();
  });

  it('keeps run history reachable when the stats fetch fails', async () => {
    vi.mocked(fetchLoops).mockResolvedValue([loop({ id: 'a', status: 'active' })]);
    vi.mocked(fetchLoopStats).mockReset().mockRejectedValue(new Error('stats down'));
    render(
      <MemoryRouter initialEntries={['/autopilot']}>
        <Routes>
          <Route path="/autopilot" element={<AutopilotView onBack={vi.fn()} providers={[]} />} />
          <Route path="/autopilot/runs" element={<div>all-runs-view</div>} />
        </Routes>
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByText('Triage new issues')).toBeInTheDocument());
    // Stats failed → the dashboard still renders and the run-history entry works.
    const tile = screen.getByRole('button', { name: /view all run history/i });
    await userEvent.click(tile);
    expect(await screen.findByText('all-runs-view')).toBeInTheDocument();
  });

  it('folds run history into a single clickable sparkline tile (no header duplicate)', async () => {
    vi.mocked(fetchLoops).mockResolvedValue([loop({ id: 'a', status: 'active' })]);
    render(
      <MemoryRouter initialEntries={['/autopilot']}>
        <Routes>
          <Route path="/autopilot" element={<AutopilotView onBack={vi.fn()} providers={[]} />} />
          <Route path="/autopilot/runs" element={<div>all-runs-view</div>} />
        </Routes>
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByText('Triage new issues')).toBeInTheDocument());
    // Exactly one run-history affordance (the folded tile), not a header button too.
    const tiles = screen.getAllByRole('button', { name: /view all run history/i });
    expect(tiles).toHaveLength(1);
    await userEvent.click(tiles[0]!);
    expect(await screen.findByText('all-runs-view')).toBeInTheDocument();
  });

  it('renders each of the four loop statuses with its chip', async () => {
    vi.mocked(fetchLoops).mockResolvedValue([
      loop({ id: 'a', goal: 'Active loop', status: 'active' }),
      loop({ id: 'p', goal: 'Paused loop', status: 'paused' }),
      loop({ id: 'b', goal: 'Broken loop', status: 'broken' }),
      loop({ id: 'c', goal: 'Completed loop', status: 'completed' }),
    ]);
    renderView();
    await waitFor(() => expect(screen.getByText('Active loop')).toBeInTheDocument());
    expect(screen.getByText('Active')).toBeInTheDocument();
    expect(screen.getByText('Paused')).toBeInTheDocument();
    expect(screen.getByText('Paused after failures')).toBeInTheDocument();
    expect(screen.getByText('Completed')).toBeInTheDocument();
  });

  it('a broken loop surfaces its failure streak plainly', async () => {
    vi.mocked(fetchLoops).mockResolvedValue([loop({ id: 'b', goal: 'Broken loop', status: 'broken' })]);
    vi.mocked(fetchLoopRuns).mockResolvedValue([
      { id: 'r1', loopId: 'b', taskId: 't1', outcome: 'failed', verify: 'red', dayBucket: '2000-01-01', createdAt: 1 },
      { id: 'r2', loopId: 'b', taskId: 't2', outcome: 'failed', verify: 'red', dayBucket: '2000-01-01', createdAt: 2 },
    ]);
    renderView();
    await waitFor(() => expect(screen.getByText(/2 failed runs in a row/i)).toBeInTheDocument());
  });

  it('pauses an active loop', async () => {
    vi.mocked(fetchLoops).mockResolvedValue([loop({ id: 'a', status: 'active' })]);
    renderView();
    await waitFor(() => expect(screen.getByText('Triage new issues')).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: /pause triage new issues/i }));
    expect(pauseLoop).toHaveBeenCalledWith('a');
  });

  it('resumes a broken loop with fix-and-resume semantics', async () => {
    vi.mocked(fetchLoops).mockResolvedValue([loop({ id: 'b', status: 'broken' })]);
    renderView();
    await waitFor(() => expect(screen.getByText('Triage new issues')).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: /fix and resume/i }));
    expect(resumeLoop).toHaveBeenCalledWith('b');
  });

  it('deletes a loop only after confirming', async () => {
    vi.mocked(fetchLoops).mockResolvedValue([loop({ id: 'a', status: 'active' })]);
    renderView();
    await waitFor(() => expect(screen.getByText('Triage new issues')).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: /delete triage new issues/i }));
    expect(deleteLoop).not.toHaveBeenCalled();
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: /delete standing task/i }));
    expect(deleteLoop).toHaveBeenCalledWith('a');
  });

  it('expands a loop row to reveal run history', async () => {
    vi.mocked(fetchLoops).mockResolvedValue([loop({ id: 'a', status: 'active' })]);
    vi.mocked(fetchLoopRuns).mockResolvedValue([
      { id: 'r1', loopId: 'a', taskId: 't1', outcome: 'ok', verify: 'green', dayBucket: '2000-01-01', createdAt: 1 },
    ]);
    renderView();
    await waitFor(() => expect(screen.getByText('Triage new issues')).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: /show run history/i }));
    expect(await screen.findByText('Succeeded')).toBeInTheDocument();
  });

  it('renders an in-flight pending run without crashing', async () => {
    vi.mocked(fetchLoops).mockResolvedValue([loop({ id: 'a', status: 'active' })]);
    vi.mocked(fetchLoopRuns).mockResolvedValue([
      { id: 'r1', loopId: 'a', taskId: 't1', outcome: 'pending', verify: 'none', dayBucket: '2000-01-01', createdAt: 1 },
    ]);
    renderView();
    await waitFor(() => expect(screen.getByText('Triage new issues')).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: /show run history/i }));
    expect(await screen.findByText(/running/i)).toBeInTheDocument();
  });

  it('shows the human-readable schedule and a next-fire countdown from the DTO', async () => {
    vi.mocked(fetchLoops).mockResolvedValue([
      loop({ id: 'a', status: 'active', schedule: { kind: 'cron', spec: 'every:1m' }, nextFireAt: Date.now() + 3 * 60_000 }),
    ]);
    renderView();
    await waitFor(() => expect(screen.getByText('Triage new issues')).toBeInTheDocument());
    expect(screen.getByText('Every 1 minute')).toBeInTheDocument();
    expect(screen.getByText(/Next run in \d+m/)).toBeInTheDocument();
  });

  it('renders gracefully when the loop has no schedule row (null-safe)', async () => {
    vi.mocked(fetchLoops).mockResolvedValue([
      loop({ id: 'a', goal: 'No-schedule loop', status: 'active', schedule: null, nextFireAt: null }),
    ]);
    renderView();
    // Mounts and shows the loop without a schedule/next-fire and without crashing.
    await waitFor(() => expect(screen.getByText('No-schedule loop')).toBeInTheDocument());
    expect(screen.queryByText(/Next run/)).not.toBeInTheDocument();
  });

  it('tolerates an unknown run outcome string in history (future bookkeeping marker)', async () => {
    vi.mocked(fetchLoops).mockResolvedValue([loop({ id: 'a', status: 'active' })]);
    vi.mocked(fetchLoopRuns).mockResolvedValue([
      // A marker the client has not modeled yet — humanized, must not crash the list.
      { id: 'r1', loopId: 'a', taskId: null, outcome: 'reconciled-late' as never, verify: 'none', dayBucket: '2000-01-01', createdAt: 1 },
    ]);
    renderView();
    await waitFor(() => expect(screen.getByText('Triage new issues')).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: /show run history/i }));
    expect(await screen.findByText('Reconciled late')).toBeInTheDocument();
  });

  it('labels a skipped-overlap run explicitly (known bookkeeping marker)', async () => {
    vi.mocked(fetchLoops).mockResolvedValue([loop({ id: 'a', status: 'active' })]);
    vi.mocked(fetchLoopRuns).mockResolvedValue([
      { id: 'r1', loopId: 'a', taskId: null, outcome: 'skipped-overlap', verify: 'none', dayBucket: '2000-01-01', createdAt: 1 },
    ]);
    renderView();
    await waitFor(() => expect(screen.getByText('Triage new issues')).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: /show run history/i }));
    expect(await screen.findByText(/a run was still in progress/i)).toBeInTheDocument();
  });

  it('renders the open dispatcher proposal as Planned for tonight', async () => {
    vi.mocked(fetchLoops).mockResolvedValue([]);
    vi.mocked(fetchAttention).mockResolvedValue({
      items: [
        dispatcherProposal({
          proposals: [
            {
              subjectKey: 'verify:nuncio',
              title: 'Fix the failing verify in nuncio',
              prompt: 'Fix the failing verify in nuncio',
              projectPath: '/Users/me/nuncio',
              rationale: 'source: open verify-dead; broken loop tripped-breaker; verify_needs_attention',
            },
            {
              subjectKey: 'issues:another-app',
              title: 'Triage open issues',
              prompt: 'Triage open issues',
              projectPath: '/Users/me/another-app',
              rationale: 'The backlog grew this week',
            },
          ],
        }),
      ],
      counts: { total: 1, unacked: 1, bySeverity: { '10': 1 } },
    });

    renderView();

    expect(await screen.findByRole('heading', { name: 'Planned for tonight' })).toBeInTheDocument();
    expect(screen.getByText('Fix the failing verify in nuncio')).toBeInTheDocument();
    expect(screen.getByText('nuncio')).toBeInTheDocument();
    expect(
      screen.getByText(
        'source: open verify-dead; broken loop tripped-breaker; verify_needs_attention',
      ),
    ).toBeInTheDocument();
    expect(screen.getByText('Triage open issues')).toBeInTheDocument();
    expect(screen.getByText('another-app')).toBeInTheDocument();
    expect(screen.getByText('The backlog grew this week')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument();
  });

  it('approves tonight’s proposal and flips the section to its done state', async () => {
    vi.mocked(fetchLoops).mockResolvedValue([]);
    vi.mocked(fetchAttention).mockResolvedValue({
      items: [
        dispatcherProposal({
          proposals: [{
            subjectKey: 'tests:flaky',
            title: 'Fix flaky tests',
            prompt: 'Fix flaky tests',
            projectPath: null,
            rationale: 'Checks failed',
          }],
        }),
      ],
      counts: { total: 1, unacked: 1, bySeverity: { '10': 1 } },
    });

    renderView();
    await userEvent.click(await screen.findByRole('button', { name: 'Approve' }));

    expect(approveDispatcherProposal).toHaveBeenCalledWith('proposal-1');
    expect(await screen.findByText('2 tasks queued')).toBeInTheDocument();
    expect(toast.success).toHaveBeenCalledWith('2 tasks queued');
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
  });

  it('renders an approved-but-open proposal in its done state', async () => {
    vi.mocked(fetchLoops).mockResolvedValue([]);
    vi.mocked(fetchAttention).mockResolvedValue({
      items: [
        dispatcherProposal({
          proposals: [{
            subjectKey: 'tests:flaky',
            title: 'Fix flaky tests',
            prompt: 'Fix flaky tests',
            projectPath: null,
            rationale: 'Checks failed',
          }],
          approvedAt: 123,
          taskIds: ['task-1'],
        }),
      ],
      counts: { total: 1, unacked: 0, bySeverity: { '10': 1 } },
    });

    renderView();

    expect(await screen.findByText('1 task queued')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
  });

  it('does not render Planned for tonight without an open dispatcher proposal', async () => {
    vi.mocked(fetchLoops).mockResolvedValue([]);
    renderView();

    await waitFor(() => expect(fetchAttention).toHaveBeenCalled());
    expect(screen.queryByRole('heading', { name: 'Planned for tonight' })).not.toBeInTheDocument();
  });

  it('renders proposal titles, rationales, and standing-task goals verbatim', async () => {
    vi.mocked(fetchLoops).mockResolvedValue([
      loop({ id: 'verbatim', goal: 'Keep the broken event loop verify wording', status: 'active' }),
    ]);
    vi.mocked(fetchAttention).mockResolvedValue({
      items: [
        dispatcherProposal({
          proposals: [
            proposal(
              'Fix the broken event loop verify bug',
              'The broken loop must verify the loop worker',
              'verbatim:proposal',
            ),
          ],
        }),
      ],
      counts: { total: 1, unacked: 1, bySeverity: { '2': 1 } },
    });

    renderView();

    expect(await screen.findByText('Fix the broken event loop verify bug')).toBeInTheDocument();
    expect(screen.getByText('The broken loop must verify the loop worker')).toBeInTheDocument();
    expect(screen.getByText('Keep the broken event loop verify wording')).toBeInTheDocument();
  });

  it('prefers the newest unapproved proposal over an older approved-open proposal', async () => {
    vi.mocked(fetchLoops).mockResolvedValue([]);
    vi.mocked(fetchAttention).mockResolvedValue({
      items: [
        dispatcherProposal(
          {
            proposals: [proposal('Yesterday done', 'Already queued', 'old:approved')],
            approvedAt: 10,
            taskIds: ['old-task'],
          },
          { id: 'old-approved', createdAt: 10 },
        ),
        dispatcherProposal(
          { proposals: [proposal('Today actionable', 'Needs approval', 'new:open')] },
          { id: 'new-open', createdAt: 20 },
        ),
      ],
      counts: { total: 2, unacked: 1, bySeverity: { '2': 2 } },
    });

    renderView();

    expect(await screen.findByText('Today actionable')).toBeInTheDocument();
    expect(screen.queryByText('Yesterday done')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument();
  });

  it('keeps approval single-flight while a standing-task action overlaps', async () => {
    const approval = deferred<{ proposalId: string; taskIds: string[] }>();
    const pause = deferred<LoopDto>();
    vi.mocked(fetchLoops).mockResolvedValue([loop({ id: 'loop-1', status: 'active' })]);
    vi.mocked(fetchAttention).mockResolvedValue({
      items: [dispatcherProposal({ proposals: [proposal('Tonight', 'Do it')] })],
      counts: { total: 1, unacked: 1, bySeverity: { '2': 1 } },
    });
    vi.mocked(approveDispatcherProposal).mockReturnValue(approval.promise);
    vi.mocked(pauseLoop).mockReturnValue(pause.promise);

    renderView();
    const approve = await screen.findByRole('button', { name: 'Approve' });
    const pauseButton = screen.getByRole('button', { name: /pause/i });
    fireEvent.click(approve);
    fireEvent.click(pauseButton);
    fireEvent.click(approve);

    await waitFor(() => {
      expect(approve).toBeDisabled();
      expect(pauseButton).toBeDisabled();
    });
    expect(approveDispatcherProposal).toHaveBeenCalledTimes(1);

    pause.resolve(loop({ id: 'loop-1', status: 'paused' }));
    await waitFor(() => expect(pauseButton).toBeEnabled());
    expect(approve).toBeDisabled();
    expect(approveDispatcherProposal).toHaveBeenCalledTimes(1);

    approval.resolve({ proposalId: 'proposal-1', taskIds: ['task-1'] });
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('1 task queued'));
  });

  it('ignores a deferred poll from before approval and refreshes after approval settles', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const stalePoll = deferred<Awaited<ReturnType<typeof fetchAttention>>>();
    const approval = deferred<{ proposalId: string; taskIds: string[] }>();
    const openItem = dispatcherProposal({ proposals: [proposal('Tonight', 'Do it')] });
    const approvedItem = dispatcherProposal({
      proposals: [proposal('Tonight', 'Do it')],
      approvedAt: 20,
      taskIds: ['task-1'],
    });
    vi.mocked(fetchLoops).mockResolvedValue([]);
    vi.mocked(fetchAttention)
      .mockResolvedValueOnce({
        items: [openItem],
        counts: { total: 1, unacked: 1, bySeverity: { '2': 1 } },
      })
      .mockReturnValueOnce(stalePoll.promise)
      .mockResolvedValue({
        items: [approvedItem],
        counts: { total: 1, unacked: 0, bySeverity: { '2': 1 } },
      });
    vi.mocked(approveDispatcherProposal).mockReturnValue(approval.promise);

    try {
      renderView();
      fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));
      await act(async () => vi.advanceTimersByTimeAsync(8000));
      approval.resolve({ proposalId: 'proposal-1', taskIds: ['task-1'] });
      await waitFor(() => expect(screen.getByText('1 task queued')).toBeInTheDocument());

      stalePoll.resolve({
        items: [openItem],
        counts: { total: 1, unacked: 1, bySeverity: { '2': 1 } },
      });
      await act(async () => undefined);

      expect(screen.getByText('1 task queued')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
      expect(fetchAttention).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the last-known plan and reports repeated attention failures once', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.mocked(fetchLoops).mockResolvedValue([]);
    vi.mocked(fetchAttention)
      .mockResolvedValueOnce({
        items: [dispatcherProposal({ proposals: [proposal('Tonight', 'Do it')] })],
        counts: { total: 1, unacked: 1, bySeverity: { '2': 1 } },
      })
      .mockRejectedValue(new Error('attention offline'));

    try {
      renderView();
      expect(await screen.findByText('Tonight')).toBeInTheDocument();
      await act(async () => vi.advanceTimersByTimeAsync(16_000));

      expect(screen.getByText('Tonight')).toBeInTheDocument();
      expect(toast.error).toHaveBeenCalledTimes(1);
      expect(toast.error).toHaveBeenCalledWith('Failed to load tonight’s plan');
    } finally {
      vi.useRealTimers();
    }
  });

  it('coalesces the same approval across the inbox card and Autopilot section', async () => {
    const approval = deferred<{ proposalId: string; taskIds: string[] }>();
    const item = dispatcherProposal({ proposals: [proposal('Shared tonight', 'Do it')] });
    vi.mocked(fetchLoops).mockResolvedValue([]);
    vi.mocked(fetchAttention).mockResolvedValue({
      items: [item],
      counts: { total: 1, unacked: 1, bySeverity: { '2': 1 } },
    });
    vi.mocked(approveDispatcherProposal).mockReturnValue(approval.promise);

    render(
      <MemoryRouter>
        <AutopilotView onBack={vi.fn()} providers={[]} />
        <AttentionQueue />
      </MemoryRouter>,
    );
    const approveButtons = await screen.findAllByRole('button', { name: /approve/i });
    expect(approveButtons).toHaveLength(2);
    fireEvent.click(approveButtons[0]!);
    fireEvent.click(approveButtons[1]!);

    expect(approveDispatcherProposal).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(approveButtons[0]).toBeDisabled();
      expect(approveButtons[1]).toBeDisabled();
    });

    approval.resolve({ proposalId: 'proposal-1', taskIds: ['task-1'] });
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('1 task queued'));
    expect(toast.success).toHaveBeenCalledTimes(1);
  });
});
