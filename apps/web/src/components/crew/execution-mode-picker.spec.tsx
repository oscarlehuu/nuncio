import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ExecutionModePicker } from './execution-mode-picker';

describe('ExecutionModePicker', () => {
  it('uses one compact segmented control while preserving radio semantics', async () => {
    const onChange = vi.fn();
    render(<ExecutionModePicker value="solo" onChange={onChange} />);

    const group = screen.getByRole('radiogroup', { name: /execution mode/i });
    expect(group).toHaveAttribute('data-density', 'compact');
    expect(group).not.toHaveClass('border');

    const solo = screen.getByRole('radio', { name: 'Solo' });
    const crew = screen.getByRole('radio', { name: 'Crew' });
    expect(solo).toHaveAttribute('aria-checked', 'true');
    expect(solo).toHaveClass('h-9');
    expect(crew).toHaveClass('h-9');

    await userEvent.click(crew);
    expect(onChange).toHaveBeenCalledWith('crew');
  });
});
