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
    render(
      <UserInputBlock requestId="r1" questions={questions} resolvedBy="user" />,
    );
    expect(screen.getByTestId('user-input-summary')).toHaveTextContent('Asked 1 question');
    expect(screen.queryByText('Which area should we focus on?')).not.toBeInTheDocument();
  });

  it('opens by default when defaultOpen is true', () => {
    render(
      <UserInputBlock requestId="r1" questions={questions} defaultOpen />,
    );
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

  it('shows skipped label when resolvedBy is skip', async () => {
    const user = userEvent.setup();
    render(<UserInputBlock requestId="r1" questions={questions} resolvedBy="skip" />);
    await user.click(screen.getByTestId('user-input-summary'));
    expect(screen.getByText(/Skipped/)).toBeInTheDocument();
  });
});
