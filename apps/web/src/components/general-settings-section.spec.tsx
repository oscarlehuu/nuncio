import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { GeneralSettingsSection } from './general-settings-section';

type ShellApi = NonNullable<NonNullable<Window['nuncioDesktop']>['shell']>;

function setDesktop(shell?: Partial<ShellApi>, marker = 'desktop') {
  (window as Window & { nuncioDesktop?: unknown }).nuncioDesktop = {
    marker,
    ...(shell ? { shell } : {}),
  };
}

describe('GeneralSettingsSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    delete (window as Window & { nuncioDesktop?: unknown }).nuncioDesktop;
  });

  it('renders nothing in a plain web browser (no desktop bridge)', () => {
    const { container } = render(<GeneralSettingsSection />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when the desktop shell has no shell IPC surface (older shell)', () => {
    setDesktop(undefined); // marker present, but no `shell`
    const { container } = render(<GeneralSettingsSection />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when getSettings rejects (state cannot be trusted)', async () => {
    const getSettings = vi.fn().mockRejectedValue(new Error('bridge down'));
    const setSettings = vi.fn();
    setDesktop({ getSettings, setSettings });
    const { container } = render(<GeneralSettingsSection />);
    await waitFor(() => expect(getSettings).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('reflects the loaded close-to-tray value as a switch', async () => {
    const getSettings = vi.fn().mockResolvedValue({ closeToTray: true });
    const setSettings = vi.fn();
    setDesktop({ getSettings, setSettings });
    render(<GeneralSettingsSection />);

    const toggle = await screen.findByRole('switch', { name: 'Keep running in the menu bar' });
    expect(toggle).toHaveAttribute('aria-checked', 'true');
  });

  it('writes the flipped value through setSettings and reconciles with the response', async () => {
    const getSettings = vi.fn().mockResolvedValue({ closeToTray: true });
    const setSettings = vi.fn().mockResolvedValue({ closeToTray: false });
    setDesktop({ getSettings, setSettings });
    const user = userEvent.setup();
    render(<GeneralSettingsSection />);

    const toggle = await screen.findByRole('switch', { name: 'Keep running in the menu bar' });
    await user.click(toggle);

    expect(setSettings).toHaveBeenCalledWith({ closeToTray: false });
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'false'));
  });

  it('rolls back the toggle when setSettings fails', async () => {
    const getSettings = vi.fn().mockResolvedValue({ closeToTray: true });
    const setSettings = vi.fn().mockRejectedValue(new Error('save failed'));
    setDesktop({ getSettings, setSettings });
    const user = userEvent.setup();
    render(<GeneralSettingsSection />);

    const toggle = await screen.findByRole('switch', { name: 'Keep running in the menu bar' });
    await user.click(toggle);

    // Optimistic flip is reverted once the write rejects.
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'true'));
  });
});
