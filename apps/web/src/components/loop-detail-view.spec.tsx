import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import userEvent from '@testing-library/user-event';

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../lib/api')>('../lib/api');
  return {
    ...actual,
    fetchLoop: vi.fn(),
    fetchLoopRuns: vi.fn(),
    updateLoop: vi.fn(),
    fireLoop: vi.fn(),
    pauseLoop: vi.fn(),
    resumeLoop: vi.fn(),
    deleteLoop: vi.fn(),
  };
});
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { LoopDetailView } from './loop-detail-view';
import {
  deleteLoop,
  fetchLoop,
  fetchLoopRuns,
  fireLoop,
  updateLoop,
  type LoopDto,
} from '../lib/api';

function loop(partial: Partial<LoopDto> = {}): LoopDto {
  return {
    id: 'l1',
    name: partial.name ?? null,
    goal: partial.goal ?? 'Nightly dependency bump',
    scheduleId: 'sch',
    schedule: { kind: 'cron', spec: 'daily@02:00' },
    nextFireAt: Date.now() + 3_600_000,
    maxRunsPerDay: 24,
    maxConsecutiveFailures: 3,
    stop: null,
    escalation: 'needs-attention',
    projectPath: '/repo',
    engine: partial.engine ?? null,
    status: partial.status ?? 'active',
    createdAt: 0,
    updatedAt: 0,
  };
}

function renderDetail(loopId = 'l1') {
  return render(
    <MemoryRouter initialEntries={[`/autopilot/${loopId}`]}>
      <Routes>
        <Route path="/autopilot/:loopId" element={<LoopDetailView providers={[{ id: 'pi', name: 'Pi' } as never]} />} />
        <Route path="/autopilot" element={<div>list</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('LoopDetailView', () => {
  beforeEach(() => {
    vi.mocked(fetchLoopRuns).mockReset().mockResolvedValue([]);
    vi.mocked(fetchLoop).mockReset().mockResolvedValue(loop());
    vi.mocked(updateLoop).mockReset().mockResolvedValue(loop());
    vi.mocked(fireLoop).mockReset().mockResolvedValue({
      id: 'r1', loopId: 'l1', taskId: 't1', outcome: 'pending', verify: 'none', dayBucket: '2000-01-01', createdAt: 1,
    });
    vi.mocked(deleteLoop).mockReset().mockResolvedValue(undefined);
  });

  it('renders the loop goal and both tabs', async () => {
    renderDetail();
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Nightly dependency bump' })).toBeInTheDocument());
    expect(screen.getByRole('tab', { name: 'Settings' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Run history' })).toBeInTheDocument();
  });

  it('Save is disabled until a field changes, then PATCHes', async () => {
    renderDetail();
    await waitFor(() => expect(screen.getByLabelText('Goal')).toBeInTheDocument());
    const save = screen.getByRole('button', { name: 'Save' });
    expect(save).toBeDisabled();
    await userEvent.type(screen.getByLabelText('Goal'), ' now');
    expect(save).toBeEnabled();
    await userEvent.click(save);
    await waitFor(() => expect(updateLoop).toHaveBeenCalled());
    expect(vi.mocked(updateLoop).mock.calls[0]![1].goal).toBe('Nightly dependency bump now');
  });

  it('edits the loop name and PATCHes it (empty stays null)', async () => {
    renderDetail();
    await waitFor(() => expect(screen.getByLabelText('Name')).toBeInTheDocument());
    await userEvent.type(screen.getByLabelText('Name'), 'Dep bumper');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(updateLoop).toHaveBeenCalled());
    expect(vi.mocked(updateLoop).mock.calls[0]![1].name).toBe('Dep bumper');
  });

  it('shows the loop name in the header when set', async () => {
    vi.mocked(fetchLoop).mockResolvedValue(loop({ name: 'Weekly docs sweep' }));
    renderDetail();
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Weekly docs sweep' })).toBeInTheDocument(),
    );
  });

  it('Run now fires an active loop', async () => {
    renderDetail();
    await waitFor(() => expect(screen.getByRole('button', { name: /run now/i })).toBeEnabled());
    await userEvent.click(screen.getByRole('button', { name: /run now/i }));
    expect(fireLoop).toHaveBeenCalledWith('l1');
  });

  it('Run now is disabled with a reason on a broken loop', async () => {
    vi.mocked(fetchLoop).mockResolvedValue(loop({ status: 'broken' }));
    renderDetail();
    await waitFor(() => expect(screen.getByRole('button', { name: /run now/i })).toBeDisabled());
    expect(screen.getByRole('button', { name: /run now/i })).toHaveAttribute('title', expect.stringMatching(/resume/i));
  });

  it('deletes via the overflow menu after confirming', async () => {
    renderDetail();
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Nightly dependency bump' })).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: /more actions/i }));
    await userEvent.click(await screen.findByRole('menuitem', { name: /delete loop/i }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete loop' }));
    expect(deleteLoop).toHaveBeenCalledWith('l1');
  });
});
