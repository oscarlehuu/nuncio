import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ApprovalModePicker } from './approval-mode-picker';

describe('ApprovalModePicker', () => {
  it('shows the selected approval mode and reports changes', async () => {
    const onChange = vi.fn();
    render(<ApprovalModePicker value="full-access" onChange={onChange} />);

    await userEvent.click(screen.getByRole('button', { name: /full access/i }));
    await userEvent.click(await screen.findByRole('menuitemradio', { name: /ask for approval/i }));

    expect(onChange).toHaveBeenCalledWith('approval-required');
  });

  it('renders embedded controls without the toolbar background class', () => {
    render(
      <ApprovalModePicker
        value="full-access"
        onChange={vi.fn()}
        surface="embedded"
      />,
    );

    const trigger = screen.getByRole('button', { name: /approval mode: full access/i });
    expect(trigger).toHaveAttribute('data-variant', 'ghost');
    expect(trigger).toHaveClass('bg-transparent', '!text-destructive');
    expect(trigger).not.toHaveClass('composer-picker-trigger');
  });
});
