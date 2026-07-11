import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ExecutionModePicker } from './execution-mode-picker';

describe('ExecutionModePicker', () => {
  it('uses one compact Crew switch with Solo represented by off', async () => {
    const onChange = vi.fn();
    render(<ExecutionModePicker value="solo" onChange={onChange} />);

    const crew = screen.getByRole('switch', { name: /crew/i });
    expect(crew).toHaveAttribute('aria-checked', 'false');
    expect(screen.queryByRole('radio', { name: /solo/i })).toBeNull();

    await userEvent.click(crew);
    expect(onChange).toHaveBeenCalledWith('crew');
  });

  it('turns Crew off by returning to Solo', async () => {
    const onChange = vi.fn();
    render(<ExecutionModePicker value="crew" onChange={onChange} />);

    const crew = screen.getByRole('switch', { name: /crew/i });
    expect(crew).toHaveAttribute('aria-checked', 'true');
    await userEvent.click(crew);
    expect(onChange).toHaveBeenCalledWith('solo');
  });
});
