import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SubagentsPanel } from './subagents-panel';
import type { TaskDto } from '../lib/api';

function makeTask(overrides: Partial<TaskDto> = {}): TaskDto {
  return {
    id: 't1',
    prompt: 'Investigate the flaky auth test',
    status: 'RUNNING',
    provider: 'pi',
    model: 'claude-fable-5',
    modelOptions: null,
    projectPath: null,
    baseBranch: null,
    useWorktree: false,
    workspace: null,
    parentSessionId: 's1',
    role: 'subagent',
    cleanupPolicy: 'after-review',
    reviewState: null,
    sessionId: 'child-session-1',
    outcome: null,
    holdUntil: null,
    pendingInput: false,
    createdAt: Date.now() - 1000,
    updatedAt: Date.now(),
    startedAt: Date.now() - 500,
    finishedAt: null,
    ...overrides,
  };
}

function renderPanel(tasks: TaskDto[], props: Partial<Parameters<typeof SubagentsPanel>[0]> = {}) {
  const onReview = vi.fn();
  const onCancel = vi.fn();
  const onRetry = vi.fn();
  const onOpenSession = vi.fn();
  const onStartNow = vi.fn();
  const onChangeModel = vi.fn();
  const onPickerOpen = vi.fn();
  const view = render(
    <SubagentsPanel
      tasks={tasks}
      onReview={onReview}
      onCancel={onCancel}
      onRetry={onRetry}
      onOpenSession={onOpenSession}
      onStartNow={onStartNow}
      onChangeModel={onChangeModel}
      onPickerOpen={onPickerOpen}
      {...props}
    />,
  );
  return { onReview, onCancel, onRetry, onOpenSession, onStartNow, onChangeModel, onPickerOpen, ...view };
}

describe('SubagentsPanel', () => {
  it('renders nothing when there are no tasks', () => {
    const { container } = renderPanel([]);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows a Needs input indicator instead of Running when the child awaits input', () => {
    renderPanel([makeTask({ status: 'RUNNING', pendingInput: true })]);
    expect(screen.getByLabelText('Needs input')).toBeInTheDocument();
    expect(screen.queryByText('Running')).toBeNull();
  });

  it('shows the plain Running status when no input is pending', () => {
    renderPanel([makeTask({ status: 'RUNNING', pendingInput: false })]);
    expect(screen.getByText('Running')).toBeInTheDocument();
    expect(screen.queryByLabelText('Needs input')).toBeNull();
  });

  it('opens the child session when a linked prompt is clicked', async () => {
    const { onOpenSession } = renderPanel([makeTask({ sessionId: 'child-session-1' })]);
    await userEvent.click(screen.getByRole('button', { name: /open subagent session/i }));
    expect(onOpenSession).toHaveBeenCalledWith('child-session-1');
  });

  it('renders queued tasks without a session as plain text, not a link', () => {
    renderPanel([makeTask({ status: 'QUEUED', sessionId: null })]);
    expect(screen.queryByRole('button', { name: /open subagent session/i })).toBeNull();
    expect(screen.getByText('Investigate the flaky auth test')).toBeInTheDocument();
  });

  it('offers Cancel only for queued tasks', async () => {
    const { onCancel } = renderPanel([makeTask({ status: 'QUEUED', sessionId: null })]);
    expect(screen.queryByRole('button', { name: /retry/i })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: /cancel/i }));
    expect(onCancel).toHaveBeenCalledWith('t1');
  });

  it('offers Retry only for terminal tasks', async () => {
    const { onRetry } = renderPanel([makeTask({ status: 'FAILED' })]);
    expect(screen.queryByRole('button', { name: /cancel/i })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(onRetry).toHaveBeenCalledWith('t1');
  });

  it('keeps the Review done action for tasks awaiting review', async () => {
    const { onReview } = renderPanel([
      makeTask({ status: 'DONE', reviewState: 'awaiting_review' }),
    ]);
    await userEvent.click(screen.getByRole('button', { name: /review done/i }));
    expect(onReview).toHaveBeenCalledWith('t1');
  });

  it('disables the row action while the request is in flight', async () => {
    let resolve!: () => void;
    const onRetry = vi.fn(() => new Promise<void>((r) => { resolve = r; }));
    renderPanel([makeTask({ status: 'FAILED' })], { onRetry });
    const button = screen.getByRole('button', { name: /retry/i });
    await userEvent.click(button);
    await waitFor(() => expect(button).toBeDisabled());
    resolve();
  });

  it('shows a live countdown and Start now action for a held queued task', () => {
    renderPanel([
      makeTask({ status: 'QUEUED', sessionId: null, holdUntil: Date.now() + 12_000 }),
    ]);
    expect(screen.getByTestId('subagent-countdown')).toHaveTextContent(/starts in \d+s/);
    expect(screen.getByRole('button', { name: /start .* now/i })).toBeInTheDocument();
    // The row is visually distinguished as held.
    expect(screen.getByTestId('subagent-row')).toHaveAttribute('data-held', 'true');
  });

  it('keeps Cancel available on a held row', () => {
    renderPanel([
      makeTask({ status: 'QUEUED', sessionId: null, holdUntil: Date.now() + 12_000 }),
    ]);
    expect(screen.getByRole('button', { name: /cancel/i })).toBeInTheDocument();
  });

  it('does not treat an expired-hold queued task as held', () => {
    renderPanel([
      makeTask({ status: 'QUEUED', sessionId: null, holdUntil: Date.now() - 1000 }),
    ]);
    expect(screen.queryByText(/starts in/)).toBeNull();
    expect(screen.queryByRole('button', { name: /start .* now/i })).toBeNull();
  });

  it('fires Start now with the task id', async () => {
    const { onStartNow } = renderPanel([
      makeTask({ status: 'QUEUED', sessionId: null, holdUntil: Date.now() + 12_000 }),
    ]);
    await userEvent.click(screen.getByRole('button', { name: /start .* now/i }));
    expect(onStartNow).toHaveBeenCalledWith('t1');
  });

  it('leaves non-held rows without a countdown', () => {
    renderPanel([makeTask({ status: 'RUNNING' })]);
    expect(screen.queryByText(/starts in/)).toBeNull();
    expect(screen.getByTestId('subagent-row')).not.toHaveAttribute('data-held');
  });

  it('disables Start now while a model change for the same row is in flight', async () => {
    // A slow model change holds the row's shared busy lock; Start now must not be
    // clickable until the update settles, so it can't launch with the stale model.
    let resolveChange!: () => void;
    const onChangeModel = vi.fn(() => new Promise<void>((r) => { resolveChange = r; }));
    const providers = [
      {
        id: 'pi',
        name: 'Pi',
        groups: [
          {
            id: 'g',
            name: 'g',
            models: [
              { id: 'claude-fable-5', name: 'Fable 5' },
              { id: 'claude-opus-4-8', name: 'Opus 4.8' },
            ],
          },
        ],
      },
    ];
    const { onStartNow } = renderPanel(
      [makeTask({ status: 'QUEUED', sessionId: null, holdUntil: Date.now() + 12_000, provider: 'pi', model: 'claude-fable-5' })],
      { onChangeModel, providers },
    );

    await userEvent.click(screen.getByRole('button', { name: /fable 5/i }));
    await userEvent.hover(await screen.findByRole('menuitem', { name: /^pi$/i }));
    await userEvent.click(await screen.findByRole('menuitem', { name: /opus 4\.8/i }));

    // Model change is pending → Start now is locked out.
    const startNow = screen.getByRole('button', { name: /start .* now/i });
    await waitFor(() => expect(startNow).toBeDisabled());
    await userEvent.click(startNow);
    expect(onStartNow).not.toHaveBeenCalled();

    resolveChange();
    await waitFor(() => expect(startNow).toBeEnabled());
  });
});

describe('SubagentsPanel countdown ticking', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('ticks the countdown down and shows a starting state at zero', () => {
    const start = 1_700_000_000_000;
    vi.setSystemTime(start);
    renderPanel([
      makeTask({ status: 'QUEUED', sessionId: null, holdUntil: start + 3_000 }),
    ]);
    // Interpolated "starts in Ns" splits into text nodes — read the whole element.
    // advanceTimersByTime moves the faked clock AND fires the 1s tick, so Date.now
    // stays in lockstep with the interval without a separate setSystemTime.
    const countdown = () => screen.getByTestId('subagent-countdown').textContent;
    expect(countdown()).toContain('starts in 3s');

    act(() => vi.advanceTimersByTime(2_000));
    expect(countdown()).toContain('starts in 1s');

    act(() => vi.advanceTimersByTime(1_500));
    // Window elapsed, poll hasn't yet flipped to RUNNING — brief starting state.
    expect(screen.queryByTestId('subagent-countdown')).toBeNull();
    expect(screen.getByText(/starting/i)).toBeInTheDocument();
  });
});
