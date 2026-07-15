import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SettingRow } from './setting-row';
import type { Setting } from '../lib/settings-api';

function makeSetting(partial: Partial<Setting> = {}): Setting {
  return {
    key: 'TEST_KEY',
    category: 'general',
    type: 'string',
    label: 'Test setting',
    description: 'A test setting description',
    hasValue: false,
    source: null,
    value: null,
    readOnly: false,
    ...partial,
  };
}

describe('SettingRow', () => {
  it('renders read-only value display', () => {
    render(
      <SettingRow
        setting={makeSetting({ readOnly: true, hasValue: true, value: '/tmp/path' })}
        onUpdate={vi.fn()}
        onClear={vi.fn()}
      />,
    );
    expect(screen.getByText('Test setting')).toBeInTheDocument();
    expect(screen.getByText('/tmp/path')).toBeInTheDocument();
    expect(screen.queryByPlaceholderText('Enter new value')).not.toBeInTheDocument();
  });

  it('toggles a boolean setting via the switch', async () => {
    const onUpdate = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(
      <SettingRow
        setting={makeSetting({ type: 'boolean', hasValue: false, value: null })}
        onUpdate={onUpdate}
        onClear={vi.fn()}
      />,
    );

    await user.click(screen.getByRole('switch', { name: 'Test setting' }));
    expect(onUpdate).toHaveBeenCalledWith('TEST_KEY', '1');
  });

  it('saves a typed string value', async () => {
    const onUpdate = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(
      <SettingRow setting={makeSetting()} onUpdate={onUpdate} onClear={vi.fn()} />,
    );

    await user.type(screen.getByPlaceholderText('Enter new value'), 'hello');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(onUpdate).toHaveBeenCalledWith('TEST_KEY', 'hello');
  });

  it('renders number settings with numeric input semantics', () => {
    render(
      <SettingRow
        setting={makeSetting({ type: 'number' })}
        onUpdate={vi.fn()}
        onClear={vi.fn()}
      />,
    );

    expect(screen.getByRole('spinbutton')).toBeInTheDocument();
  });

  it('selects an option from the option group', async () => {
    const onUpdate = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(
      <SettingRow
        setting={makeSetting({
          options: [
            { value: 'a', label: 'Option A' },
            { value: 'b', label: 'Option B', description: 'Second choice' },
          ],
          hasValue: true,
          value: 'a',
          source: 'db',
        })}
        onUpdate={onUpdate}
        onClear={vi.fn()}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Option B' }));
    expect(onUpdate).toHaveBeenCalledWith('TEST_KEY', 'b');
  });
});
