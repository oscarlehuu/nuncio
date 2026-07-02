import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../../lib/forge-api', () => ({
  fetchForgeCapabilities: vi.fn(),
  fetchForgeRunJobs: vi.fn(),
  fetchForgeJobLog: vi.fn(),
  rerunForgeRun: vi.fn(),
  cancelForgeRun: vi.fn(),
}));

import { RunDetail } from './run-detail';
import { clearForgeCache } from '../../lib/forge-cache';
import {
  cancelForgeRun,
  fetchForgeCapabilities,
  fetchForgeJobLog,
  fetchForgeRunJobs,
  rerunForgeRun,
} from '../../lib/forge-api';
import type { ForgeWorkflowRun } from '../../lib/forge-api';

const RUN: ForgeWorkflowRun = {
  id: 900,
  name: 'CI',
  runNumber: 17,
  status: 'completed',
  conclusion: 'failure',
  branch: 'main',
  sha: 'abc',
  event: 'push',
  actor: 'oscar',
  url: 'https://github.com/o/r/actions/runs/900',
  createdAt: '2026-07-02T08:00:00Z',
  durationSeconds: 150,
};

const JOB = {
  id: 5001,
  name: 'build',
  status: 'completed' as const,
  conclusion: 'failure',
  startedAt: 's',
  completedAt: 'c',
  steps: [
    { name: 'checkout', status: 'completed' as const, conclusion: 'success' },
    { name: 'test', status: 'completed' as const, conclusion: 'failure' },
  ],
};

describe('RunDetail', () => {
  beforeEach(() => {
    clearForgeCache();
    vi.mocked(fetchForgeCapabilities).mockReset().mockResolvedValue({
      provider: 'github',
      connected: true,
      authMethod: 'cli',
      requestChanges: true,
      rebaseMerge: true,
      mergeWhenChecksPass: false,
      resolveThreads: true,
      updateBranch: true,
      rerunFailedOnly: true,
    });
    vi.mocked(fetchForgeRunJobs).mockReset().mockResolvedValue([JOB]);
    vi.mocked(fetchForgeJobLog)
      .mockReset()
      .mockResolvedValue({ log: 'error: it broke', truncated: true });
    vi.mocked(rerunForgeRun).mockReset().mockResolvedValue({ ok: true });
    vi.mocked(cancelForgeRun).mockReset().mockResolvedValue({ ok: true });
  });

  it('renders jobs with steps after expanding', async () => {
    render(<RunDetail path="/repo" run={RUN} onBack={() => {}} />);

    await userEvent.click(await screen.findByText('build'));
    expect(screen.getByText('checkout')).toBeInTheDocument();
    expect(screen.getByText('test')).toBeInTheDocument();
  });

  it('offers Re-run and capability-gated Re-run failed jobs for a failed run', async () => {
    render(<RunDetail path="/repo" run={RUN} onBack={() => {}} />);
    await screen.findByText('build');

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /re-run failed jobs/i })).toBeEnabled(),
    );
    await userEvent.click(screen.getByRole('button', { name: /re-run failed jobs/i }));
    await waitFor(() => expect(rerunForgeRun).toHaveBeenCalledWith('/repo', 900, true));
  });

  it('shows Cancel instead of Re-run while the run is live', async () => {
    render(<RunDetail path="/repo" run={{ ...RUN, status: 'running', conclusion: null }} onBack={() => {}} />);
    await screen.findByText('build');

    expect(screen.queryByRole('button', { name: /^re-run$/i })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: /cancel run/i }));
    await waitFor(() => expect(cancelForgeRun).toHaveBeenCalledWith('/repo', 900));
  });

  it('loads the log tail on demand and marks truncation', async () => {
    render(<RunDetail path="/repo" run={RUN} onBack={() => {}} />);
    await userEvent.click(await screen.findByText('build'));

    await userEvent.click(screen.getByRole('button', { name: /view log/i }));

    expect(await screen.findByText('error: it broke')).toBeInTheDocument();
    expect(screen.getByText(/log tail \(truncated\)/i)).toBeInTheDocument();
    expect(fetchForgeJobLog).toHaveBeenCalledWith('/repo', 5001);
  });
});
