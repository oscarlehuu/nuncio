import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { UserInputBlock } from './user-input-block';

const questions = [
  {
    id: 'q1',
    header: 'Scope',
    prompt: 'Which area should we focus on?',
    options: [
      { id: 'a', label: 'Frontend', description: 'UI and components' },
      { id: 'b', label: 'Backend' },
    ],
  },
];

describe('UserInputBlock', () => {
  it('shows collapsed summary by default', () => {
    render(<UserInputBlock requestId="r1" questions={questions} resolvedBy="user" />);
    expect(screen.getByTestId('user-input-summary')).toHaveTextContent('Answered 1 question');
    expect(screen.queryByText('Which area should we focus on?')).not.toBeInTheDocument();
  });

  it('shows pending summary while unresolved', () => {
    render(<UserInputBlock requestId="r1" questions={questions} />);
    expect(screen.getByTestId('user-input-summary')).toHaveTextContent('Asked 1 question');
  });

  it('opens by default when defaultOpen is true', () => {
    render(<UserInputBlock requestId="r1" questions={questions} defaultOpen />);
    expect(screen.getByText('Which area should we focus on?')).toBeInTheDocument();
  });

  it('expands to show title, prompt, options, and descriptions', async () => {
    const user = userEvent.setup();
    render(
      <UserInputBlock
        requestId="r1"
        title="Pick scope"
        questions={questions}
        resolvedBy="user"
      />,
    );
    await user.click(screen.getByTestId('user-input-summary'));
    expect(screen.getByText('Pick scope')).toBeInTheDocument();
    expect(screen.getByText('Which area should we focus on?')).toBeInTheDocument();
    expect(screen.getByText('Frontend')).toBeInTheDocument();
    expect(screen.getByText('UI and components')).toBeInTheDocument();
  });

  it('marks the chosen option and shows a free-text answer', async () => {
    const user = userEvent.setup();
    render(
      <UserInputBlock
        requestId="r1"
        questions={questions}
        resolvedBy="user"
        answers={[{ questionId: 'q1', selectedOptionIds: ['b'], freeText: 'Also check tests' }]}
      />,
    );
    await user.click(screen.getByTestId('user-input-summary'));
    const backend = screen.getByText('Backend').closest('li');
    expect(backend).toHaveAttribute('data-selected');
    const frontend = screen.getByText('Frontend').closest('li');
    expect(frontend).not.toHaveAttribute('data-selected');
    expect(screen.getByTestId('user-input-free-text')).toHaveTextContent('Also check tests');
  });

  it('shows skipped label when resolvedBy is skip', () => {
    render(<UserInputBlock requestId="r1" questions={questions} resolvedBy="skip" />);
    expect(screen.getByTestId('user-input-summary')).toHaveTextContent('Question skipped');
  });
});
