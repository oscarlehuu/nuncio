import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toast } from 'sonner';
import { fetchProviderUpdates } from './provider-updates-api';
import { useProviderUpdateNotifications } from './use-provider-update-notifications';

vi.mock('sonner', () => ({
  toast: {
    info: vi.fn(),
  },
}));

vi.mock('./provider-updates-api', () => ({
  fetchProviderUpdates: vi.fn(),
}));

describe('useProviderUpdateNotifications', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    vi.mocked(fetchProviderUpdates).mockResolvedValue({
      enabled: true,
      notificationsEnabled: true,
      providers: [
        {
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
        },
      ],
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('notifies after startup delay and opens review callback from the toast action', async () => {
    const onReview = vi.fn();
    renderHook(() => useProviderUpdateNotifications(onReview));

    expect(fetchProviderUpdates).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });

    expect(toast.info).toHaveBeenCalledWith(
      'Pi CLI update available',
      expect.objectContaining({
        description: 'Review provider updates in Settings when ready.',
        action: expect.objectContaining({ label: 'Review' }),
      }),
    );

    const toastOptions = vi.mocked(toast.info).mock.calls[0]?.[1] as
      | { action?: { onClick?: () => void } }
      | undefined;
    toastOptions?.action?.onClick?.();
    expect(onReview).toHaveBeenCalledTimes(1);
  });

  it('deduplicates repeated notifications for the same latest version', async () => {
    renderHook(() => useProviderUpdateNotifications(vi.fn()));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
      await vi.advanceTimersByTimeAsync(60 * 60_000);
    });

    expect(fetchProviderUpdates).toHaveBeenCalledTimes(2);
    expect(toast.info).toHaveBeenCalledTimes(1);
  });

  it('stays quiet when update checks are disabled', async () => {
    vi.mocked(fetchProviderUpdates).mockResolvedValue({
      enabled: false,
      notificationsEnabled: false,
      providers: [],
    });

    renderHook(() => useProviderUpdateNotifications(vi.fn()));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });

    expect(toast.info).not.toHaveBeenCalled();
  });

  it('stays quiet when CLI update notifications are disabled globally', async () => {
    vi.mocked(fetchProviderUpdates).mockResolvedValue({
      enabled: true,
      notificationsEnabled: false,
      providers: [
        {
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
        },
      ],
    });

    renderHook(() => useProviderUpdateNotifications(vi.fn()));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });

    expect(toast.info).not.toHaveBeenCalled();
  });

  it('stays quiet for muted CLI update providers', async () => {
    vi.mocked(fetchProviderUpdates).mockResolvedValue({
      enabled: true,
      notificationsEnabled: true,
      providers: [
        {
          provider: 'pi',
          name: 'Pi',
          currentVersion: '0.80.2',
          latestVersion: '0.80.3',
          status: 'behind_latest',
          canUpdate: true,
          updateCommand: 'pi update',
          message: 'Pi has a newer CLI version available.',
          checkedAt: '2026-07-05T00:00:00.000Z',
          muted: true,
        },
      ],
    });

    renderHook(() => useProviderUpdateNotifications(vi.fn()));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });

    expect(toast.info).not.toHaveBeenCalled();
  });
});
