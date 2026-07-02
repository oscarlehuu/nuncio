import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { Switch } from './switch';

function ControlledSwitch({ onChange }: { onChange?: (checked: boolean) => void }) {
  const [checked, setChecked] = useState(false);
  return (
    <Switch
      checked={checked}
      onCheckedChange={(next) => {
        setChecked(next);
        onChange?.(next);
      }}
      aria-label="Demo toggle"
    />
  );
}

describe('Switch', () => {
  it('renders with role switch and unchecked state', () => {
    render(<ControlledSwitch />);
    const toggle = screen.getByRole('switch', { name: 'Demo toggle' });
    expect(toggle).toBeInTheDocument();
    expect(toggle).toHaveAttribute('aria-checked', 'false');
  });

  it('flips state and reports the change on click', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<ControlledSwitch onChange={onChange} />);

    const toggle = screen.getByRole('switch', { name: 'Demo toggle' });
    await user.click(toggle);

    expect(onChange).toHaveBeenCalledWith(true);
    expect(toggle).toHaveAttribute('aria-checked', 'true');
  });

  it('does not flip when disabled', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Switch checked={false} disabled onCheckedChange={onChange} aria-label="Locked" />);

    await user.click(screen.getByRole('switch', { name: 'Locked' }));
    expect(onChange).not.toHaveBeenCalled();
  });
});
