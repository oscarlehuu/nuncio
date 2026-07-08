import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { toast } from 'sonner';
import { ProviderUpdateSettingsSection } from './provider-update-settings-section';
import { updateSetting } from '../lib/settings-api';
import {
  fetchProviderUpdates,
  updateProviderTool,
  type ProviderUpdateStatusDto,
  type ProviderUpdatesDto,
} from '../lib/provider-updates-api';

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../lib/provider-updates-api', () => ({
  fetchProviderUpdates: vi.fn(),
  updateProviderTool: vi.fn(),
}));

vi.mock('../lib/settings-api', () => ({
  updateSetting: vi.fn(),
}));

const piBehind: ProviderUpdateStatusDto = {
  provider: 'pi',
  name: 'Pi',
  currentVersion: '0.80.2',
  latestVersion: '0.80.3',
  status: 'behind_latest',
  canUpdate: true,
  updateCommand: 'pi update',
  message: 'Pi has a newer CLI version available.',
  checkedAt: '2026-07-05T00:00:00.000Z',
  muted: false,
};

const piCurrent: ProviderUpdateStatusDto = {
  ...piBehind,
  currentVersion: '0.80.3',
  status: 'current',
  canUpdate: false,
  updateCommand: null,
  message: null,
};

function providerUpdates(providers: ProviderUpdateStatusDto[]): ProviderUpdatesDto {
  return { enabled: true, notificationsEnabled: true, providers };
}

describe('ProviderUpdateSettingsSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fetchProviderUpdates).mockResolvedValue(providerUpdates([]));
  });

  it('runs a provider update only after the user clicks Update', async () => {
    vi.mocked(fetchProviderUpdates)
      .mockResolvedValueOnce(providerUpdates([piBehind]))
      .mockResolvedValueOnce(providerUpdates([piCurrent]));
    vi.mocked(updateProviderTool).mockResolvedValue({
      provider: 'pi',
      status: 'succeeded',
      message: 'Pi updated.',
      output: null,
      providerStatus: piCurrent,
    });

    render(<ProviderUpdateSettingsSection />);

    expect(await screen.findByText('Pi CLI update available')).toBeInTheDocument();
    expect(screen.getByText('0.80.2 -> 0.80.3')).toBeInTheDocument();
    expect(screen.getByText('pi update')).toBeInTheDocument();
    expect(updateProviderTool).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: 'Update' }));

    await waitFor(() => expect(updateProviderTool).toHaveBeenCalledWith('pi'));
    await waitFor(() => expect(fetchProviderUpdates).toHaveBeenCalledTimes(2));
    expect(toast.success).toHaveBeenCalledWith('Pi updated.');
  });

  it('shows manual Codex update commands without a one-click Update button', async () => {
    vi.mocked(fetchProviderUpdates).mockResolvedValue(
      providerUpdates([
        {
          provider: 'codex',
          name: 'Codex',
          currentVersion: '0.141.0',
          latestVersion: '0.142.5',
          status: 'behind_latest',
          canUpdate: false,
          updateCommand:
            'curl -fsSL https://chatgpt.com/codex/install.sh | CODEX_NON_INTERACTIVE=1 sh',
          message: 'Codex has a newer CLI version available.',
          checkedAt: '2026-07-05T00:00:00.000Z',
          muted: false,
        },
      ]),
    );

    render(<ProviderUpdateSettingsSection />);

    expect(await screen.findByText('Codex CLI update available')).toBeInTheDocument();
    expect(screen.getByText(/CODEX_NON_INTERACTIVE=1 sh/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Update' })).not.toBeInTheDocument();
  });

  it('tells the user when provider update checks are disabled', async () => {
    vi.mocked(fetchProviderUpdates).mockResolvedValue({
      enabled: false,
      notificationsEnabled: false,
      providers: [],
    });

    render(<ProviderUpdateSettingsSection />);

    expect(await screen.findByText('Provider update checks are disabled.')).toBeInTheDocument();
  });

  it('shows failed provider update results as an error toast', async () => {
    vi.mocked(fetchProviderUpdates).mockResolvedValue(providerUpdates([piBehind]));
    vi.mocked(updateProviderTool).mockResolvedValue({
      provider: 'pi',
      status: 'failed',
      message: 'Pi update exited with code 1.',
      output: 'permission denied',
      providerStatus: piBehind,
    });

    render(<ProviderUpdateSettingsSection />);

    await userEvent.click(await screen.findByRole('button', { name: 'Update' }));

    await waitFor(() => expect(updateProviderTool).toHaveBeenCalledWith('pi'));
    expect(toast.error).toHaveBeenCalledWith('Pi update exited with code 1.');
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('mutes one CLI notification without hiding the manual update action', async () => {
    const mutedPi = { ...piBehind, muted: true };
    vi.mocked(fetchProviderUpdates)
      .mockResolvedValueOnce(providerUpdates([piBehind]))
      .mockResolvedValueOnce(providerUpdates([mutedPi]));
    vi.mocked(updateSetting).mockResolvedValue({
      key: 'NUNCIO_CLI_UPDATE_MUTED',
      category: 'advanced',
      type: 'string',
      label: 'Muted CLI update notifications',
      description: 'Muted provider tools',
      hasValue: true,
      source: 'db',
      value: 'pi',
      readOnly: false,
    });

    render(<ProviderUpdateSettingsSection />);

    expect(await screen.findByText('Pi CLI update available')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Update' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Mute Pi update notifications' }));

    await waitFor(() => expect(updateSetting).toHaveBeenCalledWith('NUNCIO_CLI_UPDATE_MUTED', 'pi'));
    await waitFor(() => expect(screen.getByText('Notifications muted')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Update' })).toBeInTheDocument();
  });
});
