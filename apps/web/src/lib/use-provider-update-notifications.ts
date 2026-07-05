import { useEffect, useRef } from 'react';
import { toast } from 'sonner';
import { fetchProviderUpdates } from './provider-updates-api';

const INITIAL_CHECK_MS = 10_000;
const CHECK_INTERVAL_MS = 60 * 60_000;

export function useProviderUpdateNotifications(onReviewUpdates: () => void) {
  const notifiedKeys = useRef(new Set<string>());

  useEffect(() => {
    let cancelled = false;

    const check = async () => {
      try {
        const updates = await fetchProviderUpdates();
        if (cancelled || !updates.enabled) return;

        const outdated = updates.providers.filter(
          (provider) => provider.status === 'behind_latest',
        );
        if (outdated.length === 0) return;

        const notificationKey = outdated
          .map((provider) => `${provider.provider}:${provider.latestVersion ?? 'latest'}`)
          .sort()
          .join('|');
        if (notifiedKeys.current.has(notificationKey)) return;
        notifiedKeys.current.add(notificationKey);

        const names = outdated.map((provider) => provider.name).join(' and ');
        toast.info(`${names} CLI update available`, {
          description: 'Review provider updates in Settings when ready.',
          action: {
            label: 'Review',
            onClick: onReviewUpdates,
          },
        });
      } catch {
        // Update checks are best-effort; Settings can still show the last error on demand.
      }
    };

    const initialTimer = window.setTimeout(() => void check(), INITIAL_CHECK_MS);
    const interval = window.setInterval(() => void check(), CHECK_INTERVAL_MS);

    return () => {
      cancelled = true;
      window.clearTimeout(initialTimer);
      window.clearInterval(interval);
    };
  }, [onReviewUpdates]);
}
