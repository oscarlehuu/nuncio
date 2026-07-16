import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { HeartbeatHealthSection } from './heartbeat-health-section';

const fetchHeartbeatHealth = vi.fn();

vi.mock('../lib/heartbeat-health-api', () => ({
  fetchHeartbeatHealth: (...args: unknown[]) => fetchHeartbeatHealth(...args),
}));

vi.mock('../lib/api', () => ({
  relativeTime: () => '2 min ago',
}));

describe('HeartbeatHealthSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders one row per system job with its outcome', async () => {
    fetchHeartbeatHealth.mockResolvedValue([
      { job: 'infra', lastRunAt: 1000, outcome: 'ok', detail: null },
      { job: 'reconcile', lastRunAt: 2000, outcome: 'error', detail: 'reconcile boom' },
    ]);
    render(<HeartbeatHealthSection />);
    await waitFor(() => expect(screen.getByText('Infra self-check')).toBeInTheDocument());
    expect(screen.getByText('Fleet reconcile')).toBeInTheDocument();
    expect(screen.getByText('ok')).toBeInTheDocument();
    expect(screen.getByText('error')).toBeInTheDocument();
    // The swallowed-error detail is now visible.
    expect(screen.getByText('reconcile boom')).toBeInTheDocument();
  });

  it('does not show a detail line for a healthy run', async () => {
    fetchHeartbeatHealth.mockResolvedValue([
      { job: 'infra', lastRunAt: 1000, outcome: 'ok', detail: 'should-not-show' },
    ]);
    render(<HeartbeatHealthSection />);
    await waitFor(() => expect(screen.getByText('ok')).toBeInTheDocument());
    expect(screen.queryByText('should-not-show')).not.toBeInTheDocument();
  });

  it('shows an empty state when no runs are recorded', async () => {
    fetchHeartbeatHealth.mockResolvedValue([]);
    render(<HeartbeatHealthSection />);
    await waitFor(() => expect(screen.getByText('No heartbeat runs recorded yet.')).toBeInTheDocument());
  });

  it('renders the empty state (not a crash) when the fetch fails', async () => {
    fetchHeartbeatHealth.mockRejectedValue(new Error('offline'));
    render(<HeartbeatHealthSection />);
    await waitFor(() => expect(screen.getByText('No heartbeat runs recorded yet.')).toBeInTheDocument());
  });
});
