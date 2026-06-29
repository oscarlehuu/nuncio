import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { UserBubble } from './transcript-bubbles';

describe('UserBubble', () => {
  it('renders short text with markdown', () => {
    render(<UserBubble text="Hello **world**" />);
    expect(screen.getByText('world').tagName).toBe('STRONG');
  });

  it('renders inline code as a code pill', () => {
    render(<UserBubble text="Use `Agent.create` now" />);
    expect(screen.getByText('Agent.create').tagName).toBe('CODE');
  });

  it('renders long text collapsed with a Show more button', () => {
    const long = 'x'.repeat(700);
    render(<UserBubble text={long} />);
    expect(screen.getByTestId('user-bubble-collapsible')).toBeInTheDocument();
    expect(screen.getByTestId('user-bubble-toggle')).toHaveTextContent(/show more/i);
    // Preview is shorter than full text.
    const toggle = screen.getByTestId('user-bubble-toggle');
    expect(toggle).toBeInTheDocument();
  });

  it('expands to show full text on click', async () => {
    const user = userEvent.setup();
    const long = `Line one\n\n${'x'.repeat(700)}`;
    render(<UserBubble text={long} />);
    await user.click(screen.getByTestId('user-bubble-toggle'));
    expect(screen.getByTestId('user-bubble-toggle')).toHaveTextContent(/show less/i);
  });

  it('does not collapse short messages', () => {
    render(<UserBubble text="Short message" />);
    expect(screen.queryByTestId('user-bubble-collapsible')).toBeNull();
    expect(screen.queryByTestId('user-bubble-toggle')).toBeNull();
  });

  it('renders markdown lists in user messages', () => {
    render(<UserBubble text={'- file a\n- file b\n- file c'} />);
    expect(screen.getByText('file a')).toBeInTheDocument();
    expect(screen.getByText('file b')).toBeInTheDocument();
    expect(screen.getByText('file c')).toBeInTheDocument();
  });
});
