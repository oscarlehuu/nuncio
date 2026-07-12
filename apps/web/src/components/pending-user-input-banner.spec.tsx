import { describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PendingUserInputBanner } from './pending-user-input-banner';

const pending = [
  {
    requestId: 'r1',
    createdAt: 1,
    title: 'Need your input',
    questions: [
      {
        id: 'q1',
        prompt: 'Which lane?',
        options: [{ id: 'a', label: 'Frontend', description: 'UI work' }],
      },
    ],
  },
];

const twoQuestions = [
  {
    requestId: 'r2',
    createdAt: 1,
    title: 'Two steps',
    questions: [
      {
        id: 'q1',
        header: 'Lane',
        prompt: 'First?',
        options: [{ id: 'a', label: 'Alpha' }],
      },
      {
        id: 'q2',
        prompt: 'Second?',
        options: [{ id: 'b', label: 'Beta' }],
      },
    ],
  },
];

describe('PendingUserInputBanner', () => {
  it('renders nothing when pending is empty', () => {
    const { container } = render(<PendingUserInputBanner pending={[]} supported={false} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows read-only form with disabled submit when unsupported', () => {
    render(
      <PendingUserInputBanner pending={pending} supported={false} providerLabel="Cursor" />,
    );
    expect(screen.getByTestId('pending-user-input-banner')).toBeInTheDocument();
    expect(screen.getByText('Need your input')).toBeInTheDocument();
    expect(screen.getByText('Which lane?')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Submit' })).toBeDisabled();
  });

  it('enables submit when supported and calls onRespond', async () => {
    const user = userEvent.setup();
    const onRespond = vi.fn();
    render(<PendingUserInputBanner pending={pending} supported onRespond={onRespond} />);

    await user.click(screen.getByRole('option', { name: /Frontend/ }));
    await user.click(screen.getByRole('button', { name: 'Submit' }));

    expect(onRespond).toHaveBeenCalledWith('r1', {
      answers: [{ questionId: 'q1', selectedOptionIds: ['a'] }],
      resolvedBy: 'user',
    });
  });

  it('shows question tabs, auto-advances, and requires every answer before submit', async () => {
    const user = userEvent.setup();
    const onRespond = vi.fn();
    render(<PendingUserInputBanner pending={twoQuestions} supported onRespond={onRespond} />);

    expect(screen.getByTestId('user-input-progress')).toHaveTextContent('0/2 answered');
    expect(screen.getByRole('tab', { name: /Lane/ })).toBeInTheDocument();
    const submit = screen.getByRole('button', { name: 'Submit' });
    expect(submit).toBeDisabled();

    // Single-select answer advances to the next unanswered question.
    await user.click(screen.getByRole('option', { name: /Alpha/ }));
    expect(screen.getByText('Second?')).toBeInTheDocument();
    expect(screen.getByTestId('user-input-progress')).toHaveTextContent('1/2 answered');
    expect(submit).toBeDisabled();

    await user.click(screen.getByRole('option', { name: /Beta/ }));
    expect(submit).toBeEnabled();

    await user.click(submit);
    expect(onRespond).toHaveBeenCalledWith('r2', {
      answers: [
        { questionId: 'q1', selectedOptionIds: ['a'] },
        { questionId: 'q2', selectedOptionIds: ['b'] },
      ],
      resolvedBy: 'user',
    });
  });

  it('supports a free-text answer through the Other option', async () => {
    const user = userEvent.setup();
    const onRespond = vi.fn();
    render(<PendingUserInputBanner pending={pending} supported onRespond={onRespond} />);

    await user.click(screen.getByTestId('user-input-other'));
    await user.type(screen.getByTestId('user-input-free-text-input'), 'Use a worktree');
    await user.click(screen.getByRole('button', { name: 'Submit' }));

    expect(onRespond).toHaveBeenCalledWith('r1', {
      answers: [{ questionId: 'q1', selectedOptionIds: [], freeText: 'Use a worktree' }],
      resolvedBy: 'user',
    });
  });

  it('shows numbered options and sends a note alongside the selection', async () => {
    const user = userEvent.setup();
    const onRespond = vi.fn();
    render(<PendingUserInputBanner pending={pending} supported onRespond={onRespond} />);

    const option = screen.getByRole('option', { name: /Frontend/ });
    expect(option).toHaveTextContent('1');

    await user.click(option);
    await user.click(screen.getByTestId('user-input-other'));
    expect(screen.getByText('Add a note…')).toBeInTheDocument();
    await user.type(screen.getByTestId('user-input-free-text-input'), 'prefer shared components');
    await user.click(screen.getByRole('button', { name: 'Submit' }));

    expect(onRespond).toHaveBeenCalledWith('r1', {
      answers: [
        { questionId: 'q1', selectedOptionIds: ['a'], freeText: 'prefer shared components' },
      ],
      resolvedBy: 'user',
    });
  });

  it('skips the whole request', async () => {
    const user = userEvent.setup();
    const onRespond = vi.fn();
    render(<PendingUserInputBanner pending={pending} supported onRespond={onRespond} />);

    await user.click(screen.getByRole('button', { name: 'Skip' }));
    expect(onRespond).toHaveBeenCalledWith('r1', { answers: [], resolvedBy: 'skip' });
  });

  it('submits Skip only once while its response is in flight', async () => {
    const user = userEvent.setup();
    let finish: () => void = () => undefined;
    const onRespond = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    render(<PendingUserInputBanner pending={pending} supported onRespond={onRespond} />);

    const skip = screen.getByRole('button', { name: 'Skip' });
    await user.click(skip);
    await user.click(skip);

    expect(onRespond).toHaveBeenCalledTimes(1);
    expect(skip).toBeDisabled();
    await act(async () => finish());
  });

  it('serializes responses when the visible pending request changes', async () => {
    const user = userEvent.setup();
    let finishFirst: () => void = () => undefined;
    const onRespond = vi.fn(() => new Promise<void>((resolve) => { finishFirst = resolve; }));
    const { rerender } = render(
      <PendingUserInputBanner pending={pending} supported onRespond={onRespond} />,
    );
    await user.click(screen.getByRole('option', { name: /Frontend/ }));
    await user.click(screen.getByRole('button', { name: 'Submit' }));

    rerender(<PendingUserInputBanner pending={twoQuestions} supported onRespond={onRespond} />);

    expect(screen.getByRole('button', { name: 'Skip' })).toBeDisabled();
    expect(screen.getByRole('option', { name: /Alpha/ })).toBeDisabled();
    await act(async () => finishFirst());
    expect(screen.getByRole('button', { name: 'Skip' })).toBeEnabled();
  });
});
