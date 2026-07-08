import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../lib/api')>('../lib/api');
  return { ...actual, createLoop: vi.fn() };
});
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
// The project picker fetches from the network; stub it to a plain field.
vi.mock('./project-picker', () => ({
  ProjectPicker: ({ onChange }: { onChange: (p: string) => void }) => (
    <button type="button" onClick={() => onChange('/Users/me/proj')}>
      pick-project
    </button>
  ),
}));

import { CreateLoopDialog } from './create-loop-dialog';
import { createLoop, type LoopDto } from '../lib/api';
import type { ModelProvider } from '../lib/model-providers';

const PROVIDERS: ModelProvider[] = [
  {
    id: 'pi',
    name: 'Pi',
    groups: [{ id: 'g', name: 'g', models: [{ id: 'claude-fable-5', name: 'Fable 5' }] }],
  },
];

const CREATED: LoopDto = {
  id: 'new',
  name: null,
  goal: 'x',
  scheduleId: 's',
  maxRunsPerDay: 24,
  maxConsecutiveFailures: 3,
  stop: null,
  escalation: 'needs-attention',
  projectPath: null,
  status: 'active',
  createdAt: 0,
  updatedAt: 0,
};

describe('CreateLoopDialog', () => {
  beforeEach(() => {
    vi.mocked(createLoop).mockReset().mockResolvedValue(CREATED);
  });

  it('disables create until a goal is entered', async () => {
    render(<CreateLoopDialog open onOpenChange={vi.fn()} onCreated={vi.fn()} />);
    const create = screen.getByRole('button', { name: /create loop/i });
    expect(create).toBeDisabled();
    await userEvent.type(screen.getByLabelText('Goal'), 'Nightly dependency bump');
    expect(create).toBeEnabled();
  });

  it('previews the schedule spec in plain English', async () => {
    render(<CreateLoopDialog open onOpenChange={vi.fn()} onCreated={vi.fn()} />);
    // Default is daily@22:00.
    expect(screen.getByText('Daily at 22:00')).toBeInTheDocument();
  });

  it('submits a well-formed create payload with the locked breaker default', async () => {
    const onCreated = vi.fn();
    render(<CreateLoopDialog open onOpenChange={vi.fn()} onCreated={onCreated} />);
    await userEvent.type(screen.getByLabelText('Goal'), 'Triage agent issues');
    await userEvent.click(screen.getByRole('button', { name: /create loop/i }));
    await waitFor(() => expect(createLoop).toHaveBeenCalledTimes(1));
    const payload = vi.mocked(createLoop).mock.calls[0]![0];
    expect(payload).toMatchObject({
      goal: 'Triage agent issues',
      schedule: { kind: 'cron', spec: 'daily@22:00' },
      maxConsecutiveFailures: 3,
      stop: null,
    });
    expect(onCreated).toHaveBeenCalledWith(CREATED);
  });

  it('builds an interval spec when the Interval tab is chosen', async () => {
    render(<CreateLoopDialog open onOpenChange={vi.fn()} onCreated={vi.fn()} />);
    await userEvent.type(screen.getByLabelText('Goal'), 'Poll for drift');
    await userEvent.click(screen.getByRole('tab', { name: 'Interval' }));
    expect(screen.getByText(/Every 6 hours/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /create loop/i }));
    await waitFor(() => expect(createLoop).toHaveBeenCalled());
    expect(vi.mocked(createLoop).mock.calls[0]![0].schedule.spec).toBe('every:6h');
  });

  it('sends the picked engine + model in the create payload', async () => {
    render(<CreateLoopDialog open onOpenChange={vi.fn()} onCreated={vi.fn()} providers={PROVIDERS} />);
    await userEvent.type(screen.getByLabelText('Goal'), 'Nightly refactor');
    await userEvent.click(
      screen.getByRole('button', { name: /engine and model: inherit from project · default model/i }),
    );
    await userEvent.click(await screen.findByRole('menuitem', { name: /fable 5/i }));
    await userEvent.click(screen.getByRole('button', { name: /create loop/i }));
    await waitFor(() => expect(createLoop).toHaveBeenCalled());
    const payload = vi.mocked(createLoop).mock.calls[0]![0];
    expect(payload.engine).toBe('pi');
    expect(payload.model).toBe('claude-fable-5');
  });

  // FIX 1 — the compact engine·model picker sits in the Goal container's footer,
  // not next to the budget fields.
  it('renders the engine·model picker inside the Goal container', async () => {
    render(<CreateLoopDialog open onOpenChange={vi.fn()} onCreated={vi.fn()} providers={PROVIDERS} />);
    const container = screen.getByTestId('loop-goal-container');
    expect(
      within(container).getByRole('button', { name: /engine and model/i }),
    ).toBeInTheDocument();
    // The Goal textarea is inside the same container.
    expect(within(container).getByLabelText('Goal')).toBeInTheDocument();
  });

  it('omits engine + model when left on inherit + default', async () => {
    render(<CreateLoopDialog open onOpenChange={vi.fn()} onCreated={vi.fn()} providers={PROVIDERS} />);
    await userEvent.type(screen.getByLabelText('Goal'), 'Nightly refactor');
    await userEvent.click(screen.getByRole('button', { name: /create loop/i }));
    await waitFor(() => expect(createLoop).toHaveBeenCalled());
    const payload = vi.mocked(createLoop).mock.calls[0]![0];
    expect(payload).not.toHaveProperty('engine');
    expect(payload).not.toHaveProperty('model');
  });

  it('attaches a maxTotalRuns stop when selected', async () => {
    render(<CreateLoopDialog open onOpenChange={vi.fn()} onCreated={vi.fn()} />);
    await userEvent.type(screen.getByLabelText('Goal'), 'Bounded improvement run');
    await userEvent.click(screen.getByRole('button', { name: /run until i pause it/i }));
    await userEvent.click(await screen.findByRole('menuitem', { name: /stop after n total runs/i }));
    await userEvent.click(screen.getByRole('button', { name: /create loop/i }));
    await waitFor(() => expect(createLoop).toHaveBeenCalled());
    expect(vi.mocked(createLoop).mock.calls[0]![0].stop).toEqual({ kind: 'maxTotalRuns', n: 5 });
  });
});
