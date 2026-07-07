import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../lib/api')>('../lib/api');
  return {
    ...actual,
    fetchLoops: vi.fn(),
    fetchLoopRuns: vi.fn(),
    pauseLoop: vi.fn(),
    resumeLoop: vi.fn(),
    deleteLoop: vi.fn(),
  };
});

// Toasts are noise in jsdom; stub sonner so the view mounts clean.
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { AutopilotView } from './autopilot-view';
import {
  deleteLoop,
  fetchLoopRuns,
  fetchLoops,
  pauseLoop,
  resumeLoop,
  type LoopDto,
} from '../lib/api';

function loop(partial: Partial<LoopDto>): LoopDto {
  return {
    id: partial.id ?? 'l1',
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

describe('AutopilotView', () => {
  beforeEach(() => {
    vi.mocked(fetchLoopRuns).mockReset().mockResolvedValue([]);
    vi.mocked(fetchLoops).mockReset();
    vi.mocked(pauseLoop).mockReset().mockResolvedValue(loop({ status: 'paused' }));
    vi.mocked(resumeLoop).mockReset().mockResolvedValue(loop({ status: 'active' }));
    vi.mocked(deleteLoop).mockReset().mockResolvedValue(undefined);
  });

  it('shows the empty state explaining a loop plus a create button', async () => {
    vi.mocked(fetchLoops).mockResolvedValue([]);
    render(<AutopilotView onBack={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('No loops yet')).toBeInTheDocument());
    expect(screen.getByText(/standing task nuncio runs on a schedule/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /create your first loop/i })).toBeInTheDocument();
  });

  it('renders each of the four loop statuses with its chip', async () => {
    vi.mocked(fetchLoops).mockResolvedValue([
      loop({ id: 'a', goal: 'Active loop', status: 'active' }),
      loop({ id: 'p', goal: 'Paused loop', status: 'paused' }),
      loop({ id: 'b', goal: 'Broken loop', status: 'broken' }),
      loop({ id: 'c', goal: 'Completed loop', status: 'completed' }),
    ]);
    render(<AutopilotView onBack={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('Active loop')).toBeInTheDocument());
    expect(screen.getByText('Active')).toBeInTheDocument();
    expect(screen.getByText('Paused')).toBeInTheDocument();
    expect(screen.getByText('Needs you')).toBeInTheDocument();
    expect(screen.getByText('Completed')).toBeInTheDocument();
  });

  it('a broken loop surfaces its failure streak plainly', async () => {
    vi.mocked(fetchLoops).mockResolvedValue([loop({ id: 'b', goal: 'Broken loop', status: 'broken' })]);
    vi.mocked(fetchLoopRuns).mockResolvedValue([
      { id: 'r1', loopId: 'b', taskId: 't1', outcome: 'failed', verify: 'red', dayBucket: '2000-01-01', createdAt: 1 },
      { id: 'r2', loopId: 'b', taskId: 't2', outcome: 'failed', verify: 'red', dayBucket: '2000-01-01', createdAt: 2 },
    ]);
    render(<AutopilotView onBack={vi.fn()} />);
    await waitFor(() => expect(screen.getByText(/2 failed runs in a row/i)).toBeInTheDocument());
  });

  it('pauses an active loop', async () => {
    vi.mocked(fetchLoops).mockResolvedValue([loop({ id: 'a', status: 'active' })]);
    render(<AutopilotView onBack={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('Triage new issues')).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: /pause triage new issues/i }));
    expect(pauseLoop).toHaveBeenCalledWith('a');
  });

  it('resumes a broken loop with fix-and-resume semantics', async () => {
    vi.mocked(fetchLoops).mockResolvedValue([loop({ id: 'b', status: 'broken' })]);
    render(<AutopilotView onBack={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('Triage new issues')).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: /fix and resume/i }));
    expect(resumeLoop).toHaveBeenCalledWith('b');
  });

  it('deletes a loop only after confirming', async () => {
    vi.mocked(fetchLoops).mockResolvedValue([loop({ id: 'a', status: 'active' })]);
    render(<AutopilotView onBack={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('Triage new issues')).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: /delete triage new issues/i }));
    expect(deleteLoop).not.toHaveBeenCalled();
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: /delete loop/i }));
    expect(deleteLoop).toHaveBeenCalledWith('a');
  });

  it('expands a loop row to reveal run history', async () => {
    vi.mocked(fetchLoops).mockResolvedValue([loop({ id: 'a', status: 'active' })]);
    vi.mocked(fetchLoopRuns).mockResolvedValue([
      { id: 'r1', loopId: 'a', taskId: 't1', outcome: 'ok', verify: 'green', dayBucket: '2000-01-01', createdAt: 1 },
    ]);
    render(<AutopilotView onBack={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('Triage new issues')).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: /show run history/i }));
    expect(await screen.findByText('Succeeded')).toBeInTheDocument();
  });

  it('renders an in-flight pending run without crashing', async () => {
    vi.mocked(fetchLoops).mockResolvedValue([loop({ id: 'a', status: 'active' })]);
    vi.mocked(fetchLoopRuns).mockResolvedValue([
      { id: 'r1', loopId: 'a', taskId: 't1', outcome: 'pending', verify: 'none', dayBucket: '2000-01-01', createdAt: 1 },
    ]);
    render(<AutopilotView onBack={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('Triage new issues')).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: /show run history/i }));
    expect(await screen.findByText(/running/i)).toBeInTheDocument();
  });

  it('shows the human-readable schedule and a next-fire countdown from the DTO', async () => {
    vi.mocked(fetchLoops).mockResolvedValue([
      loop({ id: 'a', status: 'active', schedule: { kind: 'cron', spec: 'every:1m' }, nextFireAt: Date.now() + 3 * 60_000 }),
    ]);
    render(<AutopilotView onBack={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('Triage new issues')).toBeInTheDocument());
    expect(screen.getByText('Every 1 minute')).toBeInTheDocument();
    expect(screen.getByText(/Next run in \d+m/)).toBeInTheDocument();
  });

  it('renders gracefully when the loop has no schedule row (null-safe)', async () => {
    vi.mocked(fetchLoops).mockResolvedValue([
      loop({ id: 'a', goal: 'No-schedule loop', status: 'active', schedule: null, nextFireAt: null }),
    ]);
    render(<AutopilotView onBack={vi.fn()} />);
    // Mounts and shows the loop without a schedule/next-fire and without crashing.
    await waitFor(() => expect(screen.getByText('No-schedule loop')).toBeInTheDocument());
    expect(screen.queryByText(/Next run/)).not.toBeInTheDocument();
  });

  it('tolerates an unknown run outcome string in history (future bookkeeping marker)', async () => {
    vi.mocked(fetchLoops).mockResolvedValue([loop({ id: 'a', status: 'active' })]);
    vi.mocked(fetchLoopRuns).mockResolvedValue([
      // A marker the client has not modeled yet — must not crash the history list.
      { id: 'r1', loopId: 'a', taskId: null, outcome: 'skipped-overlap' as never, verify: 'none', dayBucket: '2000-01-01', createdAt: 1 },
    ]);
    render(<AutopilotView onBack={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('Triage new issues')).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: /show run history/i }));
    expect(await screen.findByText('Skipped overlap')).toBeInTheDocument();
  });
});
