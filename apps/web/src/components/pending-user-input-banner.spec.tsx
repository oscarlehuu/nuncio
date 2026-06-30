import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
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

describe('PendingUserInputBanner', () => {
  it('renders nothing when pending is empty', () => {
    const { container } = render(
      <PendingUserInputBanner pending={[]} supported={false} />,
    );
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
    render(
      <PendingUserInputBanner pending={pending} supported onRespond={onRespond} />,
    );

    await user.click(screen.getByRole('option', { name: /Frontend/ }));
    await user.click(screen.getByRole('button', { name: 'Submit' }));

    expect(onRespond).toHaveBeenCalledWith('r1', {
      answers: [{ questionId: 'q1', selectedOptionIds: ['a'] }],
      resolvedBy: 'user',
    });
  });

  it('highlights selected option and disables Next until a choice is made', async () => {
    const user = userEvent.setup();
    const multi = [
      {
        requestId: 'r2',
        createdAt: 1,
        title: 'Two steps',
        questions: [
          {
            id: 'q1',
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
    render(<PendingUserInputBanner pending={multi} supported onRespond={vi.fn()} />);

    const next = screen.getByRole('button', { name: 'Next' });
    expect(next).toBeDisabled();

    const alpha = screen.getByRole('option', { name: /Alpha/ });
    await user.click(alpha);
    expect(alpha).toHaveAttribute('aria-pressed', 'true');
    expect(next).toBeEnabled();
  });
});
