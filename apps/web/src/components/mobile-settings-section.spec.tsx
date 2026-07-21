import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MobileSettingsSection } from './mobile-settings-section';

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

import { listDevices, revokeDevice, startPairing } from '../lib/devices-api';
import { toast } from 'sonner';

const mockStartPairing = vi.mocked(startPairing);
const mockListDevices = vi.mocked(listDevices);
const mockRevokeDevice = vi.mocked(revokeDevice);

describe('MobileSettingsSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Sensible defaults for the pairing blocks; individual tests override.
    mockListDevices.mockResolvedValue([]);
    mockStartPairing.mockResolvedValue({
      code: 'ABCD-1234',
      expiresAt: Date.now() + 5 * 60_000,
      urls: ['http://192.168.1.20:3000', 'https://mac.tail1.ts.net'],
      hints: ['On the go? Enable Tailscale Funnel for a public URL.'],
    });
    mockRevokeDevice.mockResolvedValue();
  });

  it('shows the QR payload, countdown, and hints after clicking Show QR', async () => {
    const user = userEvent.setup();
    render(<MobileSettingsSection />);

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
    mockStartPairing.mockResolvedValue({
      code: 'EXPS-0001',
      expiresAt: Date.now() + 2_000,
      urls: ['http://192.168.1.20:3000'],
      hints: [],
    });
    try {
      render(<MobileSettingsSection />);
      // Flush the mounted device-list promise under fake timers.
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
      expect(screen.getByRole('button', { name: 'Generate new code' })).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('toasts and shows no QR when startPairing fails', async () => {
    mockStartPairing.mockRejectedValue(new Error('Tailscale unreachable'));
    const user = userEvent.setup();
    render(<MobileSettingsSection />);

    await user.click(await screen.findByRole('button', { name: 'Show QR' }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Tailscale unreachable'));
    expect(screen.queryByText(/Expires in/)).not.toBeInTheDocument();
  });

  it('renders paired devices with name, platform, and last-seen', async () => {
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
    render(<MobileSettingsSection />);

    expect(await screen.findByText("Oscar's iPhone")).toBeInTheDocument();
    expect(screen.getByText('iOS')).toBeInTheDocument();
    expect(screen.getByText('5m ago')).toBeInTheDocument();
    // Soft-revoked row shows a badge, not a Revoke button.
    expect(screen.getByText('Revoked')).toBeInTheDocument();
  });

  it('ignores a superseded mint and marks the old code stale while regenerating', async () => {
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
    render(<MobileSettingsSection />);

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
    mockListDevices.mockRejectedValueOnce(new Error('offline'));
    const user = userEvent.setup();
    render(<MobileSettingsSection />);

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
    render(<MobileSettingsSection />);

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
    // A live code makes the QR visible, which turns on the 3s device poll.
    mockStartPairing.mockResolvedValue({
      code: 'LIVE-0001',
      expiresAt: Date.now() + 5 * 60_000,
      urls: ['http://192.168.1.20:3000'],
      hints: [],
    });
    mockRevokeDevice.mockResolvedValue();

    try {
      render(<MobileSettingsSection />);
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
