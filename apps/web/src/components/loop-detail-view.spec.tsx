import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import { toast } from 'sonner';
import { LoopDetailView } from './loop-detail-view';
import {
  deleteLoop,
  fetchLoop,
  fetchLoopRuns,
  fireLoop,
  resumeLoop,
  updateLoop,
  type LoopDto,
} from '../lib/api';
import type { ModelProvider } from '../lib/model-providers';

const PROVIDERS: ModelProvider[] = [
  {
    id: 'pi',
    name: 'Nuncio Engine',
    groups: [{ id: 'g', name: 'g', models: [{ id: 'claude-fable-5', name: 'Fable 5' }] }],
  },
  {
    id: 'cursor',
    name: 'Cursor',
    groups: [{ id: 'c', name: 'c', models: [{ id: 'cursor:composer-2.5', name: 'Composer 2.5' }] }],
  },
];

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
    model: partial.model ?? null,
    status: partial.status ?? 'active',
    createdAt: 0,
    updatedAt: 0,
  };
}

function renderDetail(loopId = 'l1') {
  return render(
    <MemoryRouter initialEntries={[`/autopilot/${loopId}`]}>
      <Routes>
        <Route path="/autopilot/:loopId" element={<LoopDetailView providers={PROVIDERS} />} />
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
      fired: true,
      run: { id: 'r1', loopId: 'l1', taskId: 't1', outcome: 'pending', verify: 'none', dayBucket: '2000-01-01', createdAt: 1 },
    });
    vi.mocked(toast.info).mockReset();
    vi.mocked(toast.success).mockReset();
    vi.mocked(toast.error).mockReset();
    vi.mocked(resumeLoop).mockReset().mockResolvedValue(loop({ status: 'active' }));
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
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Run started'));
  });

  it('preserves server error text verbatim', async () => {
    vi.mocked(fireLoop).mockRejectedValue(new Error('Failed to run broken event loop verify job'));
    renderDetail();
    await userEvent.click(await screen.findByRole('button', { name: /run now/i }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('Failed to run broken event loop verify job'),
    );
  });

  it('renders a user-authored goal containing loop, broken, and verify verbatim', async () => {
    vi.mocked(fetchLoop).mockResolvedValue(
      loop({ goal: 'Keep the broken event loop verify wording' }),
    );
    renderDetail();
    expect(
      await screen.findByRole('heading', { name: 'Keep the broken event loop verify wording' }),
    ).toBeInTheDocument();
  });

  it('tells the truth when a fire is skipped for overlap (409)', async () => {
    vi.mocked(fireLoop).mockResolvedValue({ fired: false, reason: 'overlap' });
    renderDetail();
    await waitFor(() => expect(screen.getByRole('button', { name: /run now/i })).toBeEnabled());
    await userEvent.click(screen.getByRole('button', { name: /run now/i }));
    await waitFor(() => expect(toast.info).toHaveBeenCalledWith('Previous run still in progress'));
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('tells the truth when a fire is skipped for budget (409)', async () => {
    vi.mocked(fireLoop).mockResolvedValue({ fired: false, reason: 'budget' });
    renderDetail();
    await waitFor(() => expect(screen.getByRole('button', { name: /run now/i })).toBeEnabled());
    await userEvent.click(screen.getByRole('button', { name: /run now/i }));
    await waitFor(() => expect(toast.info).toHaveBeenCalledWith('Daily budget spent — resumes tomorrow'));
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('Run now is disabled with a reason on a broken loop', async () => {
    vi.mocked(fetchLoop).mockResolvedValue(loop({ status: 'broken' }));
    renderDetail();
    await waitFor(() => expect(screen.getByRole('button', { name: /run now/i })).toBeDisabled());
    expect(screen.getByRole('button', { name: /run now/i })).toHaveAttribute('title', expect.stringMatching(/resume/i));
  });

  // FIX 1 — the engine·model picker lives INSIDE the Goal container (Cursor idiom),
  // not as a separate labeled row on the page background.
  it('renders the engine·model picker inside the Goal container', async () => {
    vi.mocked(fetchLoop).mockResolvedValue(loop({ engine: 'pi', model: null }));
    renderDetail();
    const container = await screen.findByTestId('loop-goal-container');
    const picker = within(container).getByRole('button', { name: /engine and model/i });
    expect(picker).toBeInTheDocument();
    // The old standalone "Engine" field label must be gone.
    expect(screen.queryByText('Engine', { selector: 'label, span' })).not.toBeInTheDocument();
  });

  // FIX 2 — one fact, one representation. active/paused = the toggle ALONE.
  it('shows only the toggle for an active loop — no redundant status chip', async () => {
    vi.mocked(fetchLoop).mockResolvedValue(loop({ status: 'active' }));
    renderDetail();
    await waitFor(() => expect(screen.getByRole('switch', { name: /standing task active/i })).toBeInTheDocument());
    // "Active" appears once (the toggle's label), never also as a status chip.
    expect(screen.getAllByText('Active')).toHaveLength(1);
    expect(screen.queryByText('Paused after failures')).not.toBeInTheDocument();
  });

  it('a paused loop shows the toggle (off), not a chip', async () => {
    vi.mocked(fetchLoop).mockResolvedValue(loop({ status: 'paused' }));
    renderDetail();
    const toggle = await screen.findByRole('switch', { name: /standing task active/i });
    expect(toggle).not.toBeChecked();
    expect(screen.getByText('Paused')).toBeInTheDocument();
  });

  it('a broken loop shows a chip + resume, and NO active toggle', async () => {
    vi.mocked(fetchLoop).mockResolvedValue(loop({ status: 'broken' }));
    vi.mocked(fetchLoopRuns).mockResolvedValue([
      { id: 'r1', loopId: 'l1', taskId: 't1', outcome: 'failed', verify: 'red', dayBucket: '2000-01-01', createdAt: 1 },
      { id: 'r2', loopId: 'l1', taskId: 't2', outcome: 'failed', verify: 'red', dayBucket: '2000-01-01', createdAt: 2 },
    ]);
    renderDetail();
    await waitFor(() => expect(screen.getByText('Paused after failures')).toBeInTheDocument());
    expect(screen.queryByRole('switch', { name: /standing task active/i })).not.toBeInTheDocument();
    expect(screen.getByText(/2 failed runs in a row/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /fix.*resume/i }));
    expect(resumeLoop).toHaveBeenCalledWith('l1');
  });

  it('a completed loop shows a completed chip and no toggle', async () => {
    vi.mocked(fetchLoop).mockResolvedValue(loop({ status: 'completed' }));
    renderDetail();
    await waitFor(() => expect(screen.getByText('Completed')).toBeInTheDocument());
    expect(screen.queryByRole('switch', { name: /standing task active/i })).not.toBeInTheDocument();
  });

  it('renders the current engine + model in the embedded control', async () => {
    vi.mocked(fetchLoop).mockResolvedValue(loop({ engine: 'pi', model: 'claude-fable-5' }));
    renderDetail();
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: /engine and model: nuncio engine · fable 5/i }),
      ).toBeInTheDocument(),
    );
  });

  it('renders inherit + default when engine and model are null', async () => {
    renderDetail();
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: /engine and model: inherit from project · default model/i }),
      ).toBeInTheDocument(),
    );
  });

  it('renders an unknown/legacy model id raw without crashing', async () => {
    vi.mocked(fetchLoop).mockResolvedValue(loop({ engine: 'pi', model: 'ghost-model-9' }));
    renderDetail();
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: /engine and model: nuncio engine · ghost-model-9/i }),
      ).toBeInTheDocument(),
    );
  });

  it('picking a different engine resets the model to the provider default', async () => {
    vi.mocked(fetchLoop).mockResolvedValue(loop({ engine: 'pi', model: 'claude-fable-5' }));
    renderDetail();
    const trigger = await screen.findByRole('button', { name: /engine and model: nuncio engine · fable 5/i });
    await userEvent.click(trigger);
    await userEvent.click(await screen.findByRole('menuitem', { name: /cursor provider default/i }));
    expect(
      await screen.findByRole('button', { name: /engine and model: cursor · default model/i }),
    ).toBeInTheDocument();
  });

  it('picking a model dirty-gates Save and PATCHes {model} only (engine unchanged)', async () => {
    vi.mocked(fetchLoop).mockResolvedValue(loop({ engine: 'pi', model: null }));
    renderDetail();
    const trigger = await screen.findByRole('button', {
      name: /engine and model: nuncio engine · default model/i,
    });
    const save = screen.getByRole('button', { name: 'Save' });
    expect(save).toBeDisabled();
    await userEvent.click(trigger);
    await userEvent.click(await screen.findByRole('menuitem', { name: /fable 5/i }));
    expect(save).toBeEnabled();
    await userEvent.click(save);
    await waitFor(() => expect(updateLoop).toHaveBeenCalled());
    // The stored engine is already 'pi' — a diff-only PATCH carries just the model.
    expect(vi.mocked(updateLoop).mock.calls[0]![1]).toMatchObject({
      model: 'claude-fable-5',
    });
  });

  it('rename-only save on a loop with a legacy model PATCHes {name} only (no model key)', async () => {
    // A stored model no longer in the catalog is rendered raw by design — but
    // re-sending it on an unrelated save would 400 (unknown model). The PATCH
    // must carry ONLY the changed field.
    vi.mocked(fetchLoop).mockResolvedValue(loop({ engine: 'pi', model: 'ghost-model-9' }));
    renderDetail();
    await waitFor(() => expect(screen.getByLabelText('Name')).toBeInTheDocument());
    await userEvent.type(screen.getByLabelText('Name'), 'Renamed loop');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(updateLoop).toHaveBeenCalled());
    const payload = vi.mocked(updateLoop).mock.calls[0]![1];
    expect(payload).toEqual({ name: 'Renamed loop' }); // ONLY the changed field
    expect(payload).not.toHaveProperty('model');
  });

  it('an engine change PATCHes {engine} WITHOUT a model key (server clears the model)', async () => {
    vi.mocked(fetchLoop).mockResolvedValue(loop({ engine: 'pi', model: 'claude-fable-5' }));
    renderDetail();
    const trigger = await screen.findByRole('button', { name: /engine and model: nuncio engine · fable 5/i });
    await userEvent.click(trigger);
    await userEvent.click(await screen.findByRole('menuitem', { name: /cursor provider default/i }));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(updateLoop).toHaveBeenCalled());
    const payload = vi.mocked(updateLoop).mock.calls[0]![1];
    expect(payload).toEqual({ engine: 'cursor' });
    expect(payload).not.toHaveProperty('model');
  });

  it('edits the breaker threshold and PATCHes maxConsecutiveFailures', async () => {
    renderDetail();
    const breaker = await screen.findByLabelText(/consecutive failures before pausing/i);
    // A clamped controlled number input: one change event mirrors select-all-then-type.
    fireEvent.change(breaker, { target: { value: '6' } });
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(updateLoop).toHaveBeenCalled());
    expect(vi.mocked(updateLoop).mock.calls[0]![1].maxConsecutiveFailures).toBe(6);
  });

  it('re-specs the trigger in place and PATCHes {schedule}', async () => {
    renderDetail();
    // Settings tab is default; switch the trigger family to Interval.
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Interval' })).toBeInTheDocument());
    await userEvent.click(screen.getByRole('tab', { name: 'Interval' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(updateLoop).toHaveBeenCalled());
    expect(vi.mocked(updateLoop).mock.calls[0]![1].schedule).toEqual({ kind: 'cron', spec: 'every:6h' });
  });

  it('switches the trigger to an event and PATCHes {schedule:{kind:event}}', async () => {
    renderDetail();
    await waitFor(() => expect(screen.getByRole('tab', { name: 'On event' })).toBeInTheDocument());
    await userEvent.click(screen.getByRole('tab', { name: 'On event' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(updateLoop).toHaveBeenCalled());
    const patch = vi.mocked(updateLoop).mock.calls[0]![1];
    expect(patch.schedule!.kind).toBe('event');
    expect(JSON.parse(patch.schedule!.spec)).toEqual({ event: 'issue.opened' });
  });

  it('Save stays disabled when the schedule is edited to an invalid time', async () => {
    renderDetail();
    // Default family is daily (a time input). Clear it → invalid → Save disabled.
    const time = await screen.findByLabelText('Time of day');
    await userEvent.clear(time);
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('an opaque/legacy stored spec does not start the form dirty', async () => {
    // A trigger kind the form cannot round-trip (heartbeat/legacy) must NOT read as
    // dirty on load — otherwise Save is enabled with nothing actually changed.
    vi.mocked(fetchLoop).mockResolvedValue({
      ...loop(),
      schedule: { kind: 'heartbeat', spec: 'system:some-internal-cadence' },
    });
    renderDetail();
    await waitFor(() => expect(screen.getByLabelText('Name')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('a rename-only save never replaces an untouched (opaque) trigger', async () => {
    vi.mocked(fetchLoop).mockResolvedValue({
      ...loop(),
      schedule: { kind: 'heartbeat', spec: 'system:some-internal-cadence' },
    });
    renderDetail();
    await waitFor(() => expect(screen.getByLabelText('Name')).toBeInTheDocument());
    await userEvent.type(screen.getByLabelText('Name'), 'Renamed');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(updateLoop).toHaveBeenCalled());
    const patch = vi.mocked(updateLoop).mock.calls[0]![1];
    expect(patch).toEqual({ name: 'Renamed' });
    expect(patch).not.toHaveProperty('schedule');
  });

  it('deletes via the overflow menu after confirming', async () => {
    renderDetail();
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Nightly dependency bump' })).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: /more actions/i }));
    await userEvent.click(await screen.findByRole('menuitem', { name: /delete standing task/i }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete standing task' }));
    expect(deleteLoop).toHaveBeenCalledWith('l1');
  });
});
