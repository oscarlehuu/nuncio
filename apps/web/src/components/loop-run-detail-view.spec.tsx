import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import userEvent from '@testing-library/user-event';

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../lib/api')>('../lib/api');
  return { ...actual, fetchLoopRunDetail: vi.fn() };
});
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { LoopRunDetailView } from './loop-run-detail-view';
import { fetchLoopRunDetail, type LoopRunDetailDto } from '../lib/api';

function detail(partial: Partial<LoopRunDetailDto> = {}): LoopRunDetailDto {
  return {
    id: 'r1',
    loopId: 'l1',
    taskId: 't1',
    outcome: 'failed',
    verify: 'red',
    dayBucket: '2000-01-01',
    createdAt: 1,
    sessionId: 's1',
    durationMs: 92_000,
    verifyOutputTail: 'FAIL broken event loop verify output\n  expected 1 to be 2',
    failureReason: 'broken event loop verify diagnostic',
    startedAt: 1,
    settledAt: 2,
    ...partial,
  };
}

function renderRun() {
  return render(
    <MemoryRouter initialEntries={['/autopilot/l1/runs/r1']}>
      <Routes>
        <Route path="/autopilot/:loopId/runs/:runId" element={<LoopRunDetailView />} />
        <Route path="/session/:id" element={<div>session page</div>} />
        <Route path="/autopilot/:loopId" element={<div>loop page</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('LoopRunDetailView', () => {
  beforeEach(() => {
    vi.mocked(fetchLoopRunDetail).mockReset().mockResolvedValue(detail());
  });

  it('shows outcome and preserves run diagnostics verbatim', async () => {
    renderRun();
    await waitFor(() => expect(screen.getByText('Failed')).toBeInTheDocument());
    expect(screen.getByText('broken event loop verify diagnostic')).toBeInTheDocument();
    expect(screen.getByText(/FAIL broken event loop verify output/)).toBeInTheDocument();
  });

  it('links into the session that ran it', async () => {
    renderRun();
    await waitFor(() => expect(screen.getByRole('button', { name: /open session/i })).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: /open session/i }));
    expect(await screen.findByText('session page')).toBeInTheDocument();
  });

  it('handles a run with no checks output', async () => {
    vi.mocked(fetchLoopRunDetail).mockResolvedValue(detail({ verifyOutputTail: null, sessionId: null }));
    renderRun();
    await waitFor(() => expect(screen.getByText(/no checks output/i)).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /open session/i })).not.toBeInTheDocument();
  });
});
