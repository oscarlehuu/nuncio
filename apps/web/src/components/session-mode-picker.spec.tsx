import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SessionModeChip, SessionModePicker } from './session-mode-picker';
import { modePlaceholder, DEFAULT_COMPOSER_PLACEHOLDER } from '../lib/session-modes';

describe('modePlaceholder', () => {
  it('returns the default copy for no mode', () => {
    expect(modePlaceholder(null)).toBe(DEFAULT_COMPOSER_PLACEHOLDER);
    expect(modePlaceholder(undefined)).toBe(DEFAULT_COMPOSER_PLACEHOLDER);
  });

  it('returns the per-mode placeholder', () => {
    expect(modePlaceholder('debug')).toMatch(/debug and troubleshoot/i);
    expect(modePlaceholder('multitask')).toMatch(/coordinate parallel/i);
  });
});

describe('SessionModeChip', () => {
  it('renders the mode label and marks the mode', () => {
    render(<SessionModeChip mode="debug" />);
    const chip = screen.getByTestId('session-mode-chip');
    expect(chip).toHaveAttribute('data-mode', 'debug');
    expect(chip).toHaveTextContent('Debug');
  });
});

describe('SessionModePicker', () => {
  it('renders nothing when the provider supports no modes', () => {
    const { container } = render(
      <SessionModePicker value={null} onChange={vi.fn()} supportedModes={[]} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the Agent trigger and offers the supported modes', async () => {
    const onChange = vi.fn();
    render(
      <SessionModePicker
        value={null}
        onChange={onChange}
        supportedModes={['debug', 'multitask']}
      />,
    );
    const trigger = screen.getByRole('button', { name: /session mode: agent/i });
    await userEvent.click(trigger);
    await userEvent.click(await screen.findByRole('menuitemradio', { name: /multitask/i }));
    expect(onChange).toHaveBeenCalledWith('multitask');
  });

  it('clearing back to Agent emits null', async () => {
    const onChange = vi.fn();
    render(
      <SessionModePicker value="debug" onChange={onChange} supportedModes={['debug']} />,
    );
    await userEvent.click(screen.getByRole('button', { name: /session mode: debug/i }));
    await userEvent.click(await screen.findByRole('menuitemradio', { name: /^agent/i }));
    expect(onChange).toHaveBeenCalledWith(null);
  });
});
