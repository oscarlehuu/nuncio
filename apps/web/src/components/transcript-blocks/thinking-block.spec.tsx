import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ThinkingBlock } from './thinking-block';

describe('ThinkingBlock (Cursor-style compact row)', () => {
  it('renders "Thought for Xs" label when not streaming', () => {
    render(<ThinkingBlock text="pondering steps" />);
    expect(screen.getByTestId('thinking-row')).toHaveTextContent(/thought for \d+s/i);
  });

  it('renders "Thinking…" label when streaming', () => {
    render(<ThinkingBlock text="so far" streaming />);
    expect(screen.getByTestId('thinking-row')).toHaveTextContent(/thinking/i);
  });

  it('starts collapsed and expands on click to reveal text', async () => {
    const user = userEvent.setup();
    render(<ThinkingBlock text="pondering steps" />);
    expect(screen.queryByText('pondering steps')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button'));
    expect(screen.getByText('pondering steps')).toBeInTheDocument();
  });
});
