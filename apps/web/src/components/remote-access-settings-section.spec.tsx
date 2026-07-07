import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RemoteAccessSettingsSection } from './remote-access-settings-section';
import type { TailscaleStatus } from '../lib/tailscale-api';

vi.mock('../lib/tailscale-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/tailscale-api')>();
  return { ...actual, fetchTailscaleStatus: vi.fn(), pushProvision: vi.fn() };
});
vi.mock('../lib/auth-api', () => ({
  fetchAuthToken: vi.fn(),
}));
vi.mock('../lib/settings-api', () => ({
  updateSetting: vi.fn(),
}));
vi.mock('../lib/devices-api', () => ({
  startPairing: vi.fn(),
  listDevices: vi.fn(),
  revokeDevice: vi.fn(),
}));
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));
// The QR block is lazy + pulls qrcode.react; render a lightweight stand-in that
// still exposes the payload text plus the stale (copy-disabled) signal so the
// pairing tests can assert on real content and behaviour.
vi.mock('./pair-qr', () => ({
  default: ({ payload, copyDisabled }: { payload: string; copyDisabled?: boolean }) => (
    <div>
      <code>{payload}</code>
      <button type="button" disabled={copyDisabled} aria-label="Copy pairing payload">
        Copy
      </button>
    </div>
  ),
}));

import { fetchTailscaleStatus, pushProvision } from '../lib/tailscale-api';
import { fetchAuthToken } from '../lib/auth-api';
import { updateSetting } from '../lib/settings-api';
import { listDevices, revokeDevice, startPairing } from '../lib/devices-api';
import { toast } from 'sonner';

const mockStatus = vi.mocked(fetchTailscaleStatus);
const mockPush = vi.mocked(pushProvision);
const mockToken = vi.mocked(fetchAuthToken);
const mockUpdate = vi.mocked(updateSetting);
const mockStartPairing = vi.mocked(startPairing);
const mockListDevices = vi.mocked(listDevices);
const mockRevokeDevice = vi.mocked(revokeDevice);

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
    // Sensible defaults for the pairing blocks; individual tests override.
    mockListDevices.mockResolvedValue([]);
    mockStartPairing.mockResolvedValue({
      code: 'ABCD-1234',
      expiresAt: Date.now() + 5 * 60_000,
      urls: ['http://192.168.1.20:3000', 'https://mac.tail1.ts.net'],
      hints: ['On the go? Enable Tailscale Funnel for a public URL.'],
    });
    mockRevokeDevice.mockResolvedValue();
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

    const toggle = await screen.findByRole('switch', { name: 'Trust my Tailscale devices' });
    expect(toggle).toHaveAttribute('aria-checked', 'true');
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

  it('pushes config to a same-user peer via Sync config after confirmation', async () => {
    mockStatus.mockResolvedValue(RUNNING_STATUS);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
    mockPush.mockResolvedValue({
      target: 'http://dev-server.tail1.ts.net:3000',
      sent: { piFiles: ['auth.json'], settings: [] },
      applied: { piFilesWritten: ['auth.json'], piFilesBackedUp: [], settingsApplied: [], settingsSkipped: [] },
    });
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const user = userEvent.setup();

    try {
      render(<RemoteAccessSettingsSection />);
      // Only the same-user online peer (dev-server) gets the button.
      const syncButton = await screen.findByRole('button', { name: 'Sync config' });
      await user.click(syncButton);
      await waitFor(() =>
        expect(mockPush).toHaveBeenCalledWith('http://dev-server.tail1.ts.net:3000'),
      );
      expect(await screen.findByRole('button', { name: 'Synced ✓' })).toBeInTheDocument();
    } finally {
      confirmSpy.mockRestore();
    }
  });

  it('does not sync when the confirmation is declined', async () => {
    mockStatus.mockResolvedValue(RUNNING_STATUS);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const user = userEvent.setup();

    try {
      render(<RemoteAccessSettingsSection />);
      await user.click(await screen.findByRole('button', { name: 'Sync config' }));
      expect(mockPush).not.toHaveBeenCalled();
    } finally {
      confirmSpy.mockRestore();
    }
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

  describe('mobile pairing', () => {
    const NOT_INSTALLED: TailscaleStatus = {
      installed: false,
      running: false,
      autoTrust: true,
      tailnet: null,
      self: null,
      peers: [],
    };

    it('shows the QR payload, countdown, and hints after clicking Show QR', async () => {
      mockStatus.mockResolvedValue(NOT_INSTALLED);
      const user = userEvent.setup();
      render(<RemoteAccessSettingsSection />);

      await user.click(await screen.findByRole('button', { name: 'Show QR' }));

      // Payload is the exact { v, code, urls } JSON the phone scans.
      const expectedPayload = JSON.stringify({
        v: 1,
        code: 'ABCD-1234',
        urls: ['http://192.168.1.20:3000', 'https://mac.tail1.ts.net'],
      });
      expect(await screen.findByText(expectedPayload)).toBeInTheDocument();
      expect(screen.getByText(/Expires in \d:\d\d/)).toBeInTheDocument();
      expect(
        screen.getByText('On the go? Enable Tailscale Funnel for a public URL.'),
      ).toBeInTheDocument();
    });

    it('flips to a regenerate state when the code expires', async () => {
      vi.useFakeTimers();
      mockStatus.mockResolvedValue(NOT_INSTALLED);
      mockStartPairing.mockResolvedValue({
        code: 'EXPS-0001',
        expiresAt: Date.now() + 2_000,
        urls: ['http://192.168.1.20:3000'],
        hints: [],
      });
      try {
        render(<RemoteAccessSettingsSection />);
        // Flush the mounted status/token promises under fake timers.
        await vi.advanceTimersByTimeAsync(0);

        await act(async () => {
          fireEvent.click(screen.getByRole('button', { name: 'Show QR' }));
          await vi.advanceTimersByTimeAsync(0);
        });
        expect(screen.getByText(/Expires in/)).toBeInTheDocument();

        await act(async () => {
          await vi.advanceTimersByTimeAsync(2_500);
        });

        expect(screen.getByText('Code expired')).toBeInTheDocument();
        expect(
          screen.getByRole('button', { name: 'Generate new code' }),
        ).toBeInTheDocument();
      } finally {
        vi.useRealTimers();
      }
    });

    it('toasts and shows no QR when startPairing fails', async () => {
      mockStatus.mockResolvedValue(NOT_INSTALLED);
      mockStartPairing.mockRejectedValue(new Error('Tailscale unreachable'));
      const user = userEvent.setup();
      render(<RemoteAccessSettingsSection />);

      await user.click(await screen.findByRole('button', { name: 'Show QR' }));

      await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Tailscale unreachable'));
      expect(screen.queryByText(/Expires in/)).not.toBeInTheDocument();
    });

    it('renders paired devices with name, platform, and last-seen', async () => {
      mockStatus.mockResolvedValue(NOT_INSTALLED);
      mockListDevices.mockResolvedValue([
        {
          id: 'dev-1',
          name: "Oscar's iPhone",
          platform: 'iOS',
          createdAt: Date.now() - 86_400_000,
          lastSeenAt: Date.now() - 5 * 60_000,
          revoked: false,
        },
        {
          id: 'dev-2',
          name: 'Old Pixel',
          platform: 'Android',
          createdAt: Date.now() - 3 * 86_400_000,
          lastSeenAt: null,
          revoked: true,
        },
      ]);
      render(<RemoteAccessSettingsSection />);

      expect(await screen.findByText("Oscar's iPhone")).toBeInTheDocument();
      expect(screen.getByText('iOS')).toBeInTheDocument();
      expect(screen.getByText('5m ago')).toBeInTheDocument();
      // Soft-revoked row shows a badge, not a Revoke button.
      expect(screen.getByText('Revoked')).toBeInTheDocument();
    });

    it('ignores a superseded mint and marks the old code stale while regenerating', async () => {
      mockStatus.mockResolvedValue(NOT_INSTALLED);
      // First mint resolves fast; the second (New code) is held open so we can observe
      // the in-flight stale state, then resolve it last.
      let releaseSecond: (() => void) | undefined;
      mockStartPairing
        .mockResolvedValueOnce({
          code: 'FIRST-0001',
          expiresAt: Date.now() + 5 * 60_000,
          urls: ['http://192.168.1.20:3000'],
          hints: [],
        })
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              releaseSecond = () =>
                resolve({
                  code: 'SECOND-0002',
                  expiresAt: Date.now() + 5 * 60_000,
                  urls: ['http://192.168.1.20:3000'],
                  hints: [],
                });
            }),
        );
      const user = userEvent.setup();
      render(<RemoteAccessSettingsSection />);

      await user.click(await screen.findByRole('button', { name: 'Show QR' }));
      const firstPayload = JSON.stringify({
        v: 1,
        code: 'FIRST-0001',
        urls: ['http://192.168.1.20:3000'],
      });
      expect(await screen.findByText(firstPayload)).toBeInTheDocument();

      // Kick off the replacement; the old code must read as stale (copy disabled).
      await user.click(screen.getByRole('button', { name: 'New code' }));
      expect(await screen.findByText('Refreshing code…')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Copy pairing payload' })).toBeDisabled();

      releaseSecond?.();

      // The newer code lands and replaces the stale one; exactly two mints total.
      const secondPayload = JSON.stringify({
        v: 1,
        code: 'SECOND-0002',
        urls: ['http://192.168.1.20:3000'],
      });
      expect(await screen.findByText(secondPayload)).toBeInTheDocument();
      expect(screen.queryByText('Refreshing code…')).not.toBeInTheDocument();
      expect(mockStartPairing).toHaveBeenCalledTimes(2);
    });

    it('surfaces a retryable error instead of an empty state when listDevices fails', async () => {
      mockStatus.mockResolvedValue(NOT_INSTALLED);
      mockListDevices.mockRejectedValueOnce(new Error('offline'));
      const user = userEvent.setup();
      render(<RemoteAccessSettingsSection />);

      expect(await screen.findByText("Couldn't load paired devices.")).toBeInTheDocument();
      // The misleading empty state must NOT show when the load failed.
      expect(screen.queryByText('No devices paired yet.')).not.toBeInTheDocument();

      // Retry succeeds and renders the real list.
      mockListDevices.mockResolvedValueOnce([
        {
          id: 'dev-1',
          name: "Oscar's iPhone",
          platform: 'iOS',
          createdAt: Date.now() - 86_400_000,
          lastSeenAt: Date.now() - 5 * 60_000,
          revoked: false,
        },
      ]);
      await user.click(screen.getByRole('button', { name: 'Retry' }));

      expect(await screen.findByText("Oscar's iPhone")).toBeInTheDocument();
      expect(screen.queryByText("Couldn't load paired devices.")).not.toBeInTheDocument();
    });

    it('revokes a device through the Dialog confirm, then refreshes and toasts', async () => {
      mockStatus.mockResolvedValue(NOT_INSTALLED);
      mockListDevices.mockResolvedValue([
        {
          id: 'dev-1',
          name: "Oscar's iPhone",
          platform: 'iOS',
          createdAt: Date.now() - 86_400_000,
          lastSeenAt: Date.now() - 5 * 60_000,
          revoked: false,
        },
      ]);
      const user = userEvent.setup();
      render(<RemoteAccessSettingsSection />);

      await user.click(await screen.findByRole('button', { name: 'Revoke' }));
      // Dialog confirm — not window.confirm.
      expect(await screen.findByRole('dialog')).toBeInTheDocument();

      mockListDevices.mockClear();
      await user.click(screen.getByRole('button', { name: 'Revoke device' }));

      await waitFor(() => expect(mockRevokeDevice).toHaveBeenCalledWith('dev-1'));
      expect(toast.success).toHaveBeenCalledWith('Device revoked');
      // List reloads after a successful revoke.
      expect(mockListDevices).toHaveBeenCalled();
    });

    it('drops a stale poll response that resolves after the post-revoke refresh', async () => {
      vi.useFakeTimers();
      const device = {
        id: 'dev-1',
        name: "Oscar's iPhone",
        platform: 'iOS',
        createdAt: Date.now() - 86_400_000,
        lastSeenAt: Date.now() - 5 * 60_000,
        revoked: false,
      };
      const present = [device];
      const gone: typeof present = [];

      // Hand out a controllable promise per listDevices() call so resolution order is
      // decoupled from call order — this is what lets an earlier poll resolve LAST.
      const deferreds: Array<{ resolve: (v: typeof present) => void }> = [];
      mockListDevices.mockImplementation(
        () =>
          new Promise<typeof present>((resolve) => {
            deferreds.push({ resolve });
          }),
      );
      mockStatus.mockResolvedValue(NOT_INSTALLED);
      // A live code makes the QR visible, which turns on the 3s device poll.
      mockStartPairing.mockResolvedValue({
        code: 'LIVE-0001',
        expiresAt: Date.now() + 5 * 60_000,
        urls: ['http://192.168.1.20:3000'],
        hints: [],
      });
      mockRevokeDevice.mockResolvedValue();

      try {
        render(<RemoteAccessSettingsSection />);
        await act(async () => {
          await vi.advanceTimersByTimeAsync(0);
        });

        // deferreds[0] = mount load. Resolve it so the device is on screen.
        await act(async () => {
          deferreds[0].resolve(present);
        });
        expect(screen.getByText("Oscar's iPhone")).toBeInTheDocument();

        // Show the QR so the 3s poll starts.
        await act(async () => {
          fireEvent.click(screen.getByRole('button', { name: 'Show QR' }));
          await vi.advanceTimersByTimeAsync(0);
        });

        // Fire exactly one poll tick; its listDevices() response stays pending.
        const beforePoll = deferreds.length;
        await act(async () => {
          await vi.advanceTimersByTimeAsync(3_000);
        });
        expect(deferreds.length).toBe(beforePoll + 1);
        const earlierPoll = deferreds[deferreds.length - 1];

        // Revoke while that poll is in flight → revokeDevice, then the post-revoke load().
        await act(async () => {
          fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));
          await vi.advanceTimersByTimeAsync(0);
        });
        await act(async () => {
          fireEvent.click(screen.getByRole('button', { name: 'Revoke device' }));
          await vi.advanceTimersByTimeAsync(0);
        });
        expect(mockRevokeDevice).toHaveBeenCalledWith('dev-1');
        // The post-revoke load() is the newest listDevices call, started after the poll.
        expect(deferreds.length).toBe(beforePoll + 2);
        const postRevokeLoad = deferreds[deferreds.length - 1];

        // Newest (post-revoke) load resolves first: device is gone.
        await act(async () => {
          postRevokeLoad.resolve(gone);
        });
        expect(screen.queryByText("Oscar's iPhone")).not.toBeInTheDocument();

        // The STALE earlier poll resolves LAST with the device still present — it must be dropped.
        await act(async () => {
          earlierPoll.resolve(present);
        });
        expect(screen.queryByText("Oscar's iPhone")).not.toBeInTheDocument();
        expect(screen.getByText('No devices paired yet.')).toBeInTheDocument();
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
