import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CrewRunSummaryDto } from '@nuncio/core/crew-api';

const api = vi.hoisted(() => ({ fetchCrewRuns: vi.fn() }));
vi.mock('@nuncio/core/crew-api', () => api);

import { RecentCrewRuns } from './recent-crew-runs';

function run(id: string, taskId: string, updatedAt: number, status: CrewRunSummaryDto['status'] = 'RUNNING') {
  return {
    id,
    taskId,
    objective: `Objective ${taskId}`,
    updatedAt,
    createdAt: updatedAt - 1,
    phase: status === 'TERMINAL' ? 'DONE' : 'BUILD',
    status,
    outcome: status === 'TERMINAL' ? 'SUCCEEDED' : null,
    blockedReason: null,
    revision: 1,
    workspaceHead: 'a'.repeat(40),
  } as CrewRunSummaryDto;
}

function renderRecent() {
  return render(<MemoryRouter><RecentCrewRuns /></MemoryRouter>);
}

describe('RecentCrewRuns', () => {
  afterEach(() => vi.useRealTimers());

  beforeEach(() => {
    api.fetchCrewRuns.mockReset();
  });

  it('requests and shows a bounded server-projected list with immutable run links', async () => {
    api.fetchCrewRuns.mockResolvedValue([
      run('run-new', 'task-1', 100, 'TERMINAL'),
      run('run-2', 'task-2', 90),
      run('run-3', 'task-3', 80),
      run('run-4', 'task-4', 70),
      run('run-5', 'task-5', 60),
    ]);
    renderRecent();

    expect(await screen.findByRole('heading', { name: 'Recent Crew' })).toBeInTheDocument();
    const links = screen.getAllByRole('link');
    expect(links).toHaveLength(5);
    expect(links[0]).toHaveClass('min-h-11');
    expect(screen.getByRole('link', { name: /Objective task-1/ })).toHaveAttribute(
      'href',
      '/crew/task-1?run=run-new',
    );
    expect(screen.getByText(/Succeeded/)).toBeInTheDocument();
    expect(screen.getAllByText(/Running/).length).toBeGreaterThan(0);
    expect(api.fetchCrewRuns).toHaveBeenCalledWith({ limit: 5 });
  });

  it('keeps Home usable on load failure and supports an explicit retry', async () => {
    api.fetchCrewRuns.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce([]);
    renderRecent();

    expect(await screen.findByText('Recent Crew unavailable')).toBeInTheDocument();
    const retry = screen.getByRole('button', { name: 'Retry recent Crew' });
    expect(retry).toHaveClass('min-h-11');
    await userEvent.click(retry);
    expect(await screen.findByText('No Crew tasks yet.')).toBeInTheDocument();
    expect(api.fetchCrewRuns).toHaveBeenCalledTimes(2);
  });

  it('polls every five seconds only while a visible run is non-terminal', async () => {
    vi.useFakeTimers();
    api.fetchCrewRuns
      .mockResolvedValueOnce([run('run-active', 'task-1', 10)])
      .mockResolvedValueOnce([run('run-done', 'task-1', 20, 'TERMINAL')]);
    renderRecent();
    await flushPromises();
    expect(api.fetchCrewRuns).toHaveBeenCalledTimes(1);

    await act(async () => { await vi.advanceTimersByTimeAsync(4_999); });
    expect(api.fetchCrewRuns).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    await flushPromises();
    expect(api.fetchCrewRuns).toHaveBeenCalledTimes(2);
    expect(screen.getByText(/Succeeded/)).toBeInTheDocument();

    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(api.fetchCrewRuns).toHaveBeenCalledTimes(2);
  });

  it('skips overlapping polls and invalidates a late response after cleanup', async () => {
    vi.useFakeTimers();
    let resolvePoll!: (runs: CrewRunSummaryDto[]) => void;
    api.fetchCrewRuns
      .mockResolvedValueOnce([run('run-active', 'task-1', 10)])
      .mockImplementationOnce(() => new Promise<CrewRunSummaryDto[]>((resolve) => { resolvePoll = resolve; }));
    const view = renderRecent();
    await flushPromises();

    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(api.fetchCrewRuns).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(api.fetchCrewRuns).toHaveBeenCalledTimes(2);

    view.unmount();
    await act(async () => { resolvePoll([run('run-done', 'task-1', 20, 'TERMINAL')]); });
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(api.fetchCrewRuns).toHaveBeenCalledTimes(2);
  });
});

async function flushPromises() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}
