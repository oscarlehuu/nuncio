import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RemoteAccessSettingsSection } from './remote-access-settings-section';
import type { TailscaleStatus } from '../lib/tailscale-api';

vi.mock('../lib/tailscale-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/tailscale-api')>();
  return { ...actual, fetchTailscaleStatus: vi.fn() };
});
vi.mock('../lib/auth-api', () => ({
  fetchAuthToken: vi.fn(),
}));
vi.mock('../lib/settings-api', () => ({
  updateSetting: vi.fn(),
}));

import { fetchTailscaleStatus } from '../lib/tailscale-api';
import { fetchAuthToken } from '../lib/auth-api';
import { updateSetting } from '../lib/settings-api';

const mockStatus = vi.mocked(fetchTailscaleStatus);
const mockToken = vi.mocked(fetchAuthToken);
const mockUpdate = vi.mocked(updateSetting);

const RUNNING_STATUS: TailscaleStatus = {
  installed: true,
  running: true,
  autoTrust: true,
  tailnet: 'oscar@example.com',
  self: {
    hostName: 'my-mac',
    dnsName: 'my-mac.tail1.ts.net',
    ips: ['100.94.230.13'],
    os: 'macOS',
    loginName: 'oscar@',
  },
  peers: [
    {
      hostName: 'dev-server',
      dnsName: 'dev-server.tail1.ts.net',
      ips: ['100.105.188.11'],
      os: 'linux',
      online: true,
      loginName: 'oscar@',
      sameUser: true,
    },
    {
      hostName: 'friend-box',
      dnsName: 'friend-box.tail2.ts.net',
      ips: ['100.64.94.44'],
      os: 'linux',
      online: false,
      loginName: 'friend@',
      sameUser: false,
    },
  ],
};

describe('RemoteAccessSettingsSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockToken.mockResolvedValue({ token: 'tok-123', source: '/data/auth-token' });
    // Peer nuncio probe uses global fetch; fail it so no Open buttons render.
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('no probe')));
  });

  it('renders tailnet devices with trust badges', async () => {
    mockStatus.mockResolvedValue(RUNNING_STATUS);
    render(<RemoteAccessSettingsSection />);

    expect(await screen.findByText('dev-server')).toBeInTheDocument();
    expect(screen.getByText('friend-box')).toBeInTheDocument();
    expect(screen.getByText('Trusted')).toBeInTheDocument();
    expect(screen.getByText('Token required')).toBeInTheDocument();
  });

  it('toggles auto-trust via updateSetting', async () => {
    mockStatus.mockResolvedValue(RUNNING_STATUS);
    mockUpdate.mockResolvedValue({} as never);
    const user = userEvent.setup();
    render(<RemoteAccessSettingsSection />);

    const toggle = await screen.findByRole('button', { name: 'Trust my Tailscale devices' });
    expect(toggle).toHaveTextContent('On');
    await user.click(toggle);

    await waitFor(() =>
      expect(mockUpdate).toHaveBeenCalledWith('NUNCIO_TAILSCALE_AUTO_TRUST', '0'),
    );
  });

  it('shows the install hint when Tailscale is not detected', async () => {
    mockStatus.mockResolvedValue({
      installed: false,
      running: false,
      autoTrust: true,
      tailnet: null,
      self: null,
      peers: [],
    });
    render(<RemoteAccessSettingsSection />);

    expect(await screen.findByText('Not detected on this machine.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'tailscale.com/download' })).toBeInTheDocument();
  });

  it('switches the desktop shell to a peer via Connect when the servers bridge exists', async () => {
    mockStatus.mockResolvedValue(RUNNING_STATUS);
    // Probe succeeds → the peer is running nuncio.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
    const connect = vi.fn().mockResolvedValue({ ok: true });
    window.nuncioDesktop = { servers: { connect, list: vi.fn() } };
    const user = userEvent.setup();

    try {
      render(<RemoteAccessSettingsSection />);
      const connectButton = await screen.findByRole('button', { name: 'Connect' });
      await user.click(connectButton);
      expect(connect).toHaveBeenCalledWith('http://dev-server.tail1.ts.net:3000');
      expect(screen.queryByRole('link', { name: /Open/ })).not.toBeInTheDocument();
    } finally {
      delete window.nuncioDesktop;
    }
  });

  it('reveals the access token on demand', async () => {
    mockStatus.mockResolvedValue(RUNNING_STATUS);
    const user = userEvent.setup();
    render(<RemoteAccessSettingsSection />);

    const reveal = await screen.findByRole('button', { name: 'Reveal access token' });
    expect(screen.queryByText('tok-123')).not.toBeInTheDocument();
    await user.click(reveal);
    expect(await screen.findByText('tok-123')).toBeInTheDocument();
  });
});
