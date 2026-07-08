import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import userEvent from '@testing-library/user-event';

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../lib/api')>('../lib/api');
  return { ...actual, fetchLoops: vi.fn(), fetchLoopRuns: vi.fn() };
});
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { GlobalRunsView } from './global-runs-view';
import { fetchLoops, fetchLoopRuns, type LoopDto } from '../lib/api';

const LOOP = {
  id: 'l1',
  goal: 'Docs drift sweep',
  scheduleId: 's',
  maxRunsPerDay: 24,
  maxConsecutiveFailures: 3,
  stop: null,
  escalation: 'needs-attention',
  projectPath: null,
  status: 'active',
  createdAt: 0,
  updatedAt: 0,
} as LoopDto;

function renderRuns() {
  return render(
    <MemoryRouter initialEntries={['/autopilot/runs']}>
      <Routes>
        <Route path="/autopilot/runs" element={<GlobalRunsView />} />
        <Route path="/autopilot/:loopId/runs/:runId" element={<div>run page</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('GlobalRunsView', () => {
  beforeEach(() => {
    vi.mocked(fetchLoops).mockReset().mockResolvedValue([LOOP]);
    vi.mocked(fetchLoopRuns).mockReset().mockResolvedValue([
      { id: 'r1', loopId: 'l1', taskId: 't1', outcome: 'ok', verify: 'green', dayBucket: '2000-01-01', createdAt: 10 },
      { id: 'r2', loopId: 'l1', taskId: 't2', outcome: 'failed', verify: 'red', dayBucket: '2000-01-01', createdAt: 20 },
    ]);
  });

  it('renders a row per run with its loop and status, newest first', async () => {
    renderRuns();
    await waitFor(() => expect(screen.getAllByText('Docs drift sweep').length).toBe(2));
    expect(screen.getByText('Succeeded')).toBeInTheDocument();
    expect(screen.getByText('Failed')).toBeInTheDocument();
  });

  it('opens a run detail on row click', async () => {
    renderRuns();
    await waitFor(() => expect(screen.getByText('Succeeded')).toBeInTheDocument());
    await userEvent.click(screen.getByText('Failed').closest('tr')!);
    expect(await screen.findByText('run page')).toBeInTheDocument();
  });

  it('shows the empty state when no loops have run', async () => {
    vi.mocked(fetchLoops).mockResolvedValue([]);
    renderRuns();
    await waitFor(() => expect(screen.getByText(/no runs yet/i)).toBeInTheDocument());
  });
});
