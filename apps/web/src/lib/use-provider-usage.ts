import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import type { UsageProviderId, UsageSnapshotDto } from './usage-api';
import { isUsageProviderId } from './usage-display';
import {
  ensureUsageCache,
  getUsageCacheState,
  subscribeUsageCache,
} from './usage-cache';

function useUsageCacheStore() {
  return useSyncExternalStore(subscribeUsageCache, getUsageCacheState, getUsageCacheState);
}

/**
 * Shared usage snapshots for chips (home/session). Soft-cached 5m; background
 * tick only pulls when stale. `reload(true)` forces a network refresh.
 */
export function useProviderUsage(activeProvider?: string | null) {
  const cache = useUsageCacheStore();
  const [bootstrapped, setBootstrapped] = useState(() => cache.fetchedAt != null);

  useEffect(() => {
    let cancelled = false;
    void ensureUsageCache({ force: false }).finally(() => {
      if (!cancelled) setBootstrapped(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        // Soft: only network if TTL expired.
        void ensureUsageCache({ force: false });
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  const reload = useCallback(async (forceRefresh = false) => {
    await ensureUsageCache({ force: forceRefresh });
  }, []);

  const activeId: UsageProviderId | null = isUsageProviderId(activeProvider)
    ? activeProvider
    : null;
  const active: UsageSnapshotDto | null = activeId
    ? cache.snapshots.find((s) => s.provider === activeId) ?? null
    : null;

  return {
    snapshots: cache.snapshots,
    active,
    loading: !bootstrapped || (cache.loading && cache.fetchedAt == null),
    error: cache.error,
    reload,
  };
}

/**
 * Settings Usage panel: same cache as chips, plus history for the chart.
 */
export function useUsageSettingsData() {
  const cache = useUsageCacheStore();
  const [bootstrapped, setBootstrapped] = useState(
    () => cache.fetchedAt != null && cache.historyFetchedAt != null,
  );
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void ensureUsageCache({ force: false, history: true }).finally(() => {
      if (!cancelled) setBootstrapped(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        void ensureUsageCache({ force: false, history: true });
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  const reload = useCallback(async (forceRefresh = false) => {
    if (forceRefresh) setRefreshing(true);
    try {
      await ensureUsageCache({ force: forceRefresh, history: true });
    } finally {
      setRefreshing(false);
    }
  }, []);

  return {
    snapshots: cache.snapshots,
    history: cache.history,
    loading: !bootstrapped || (cache.loading && cache.fetchedAt == null),
    refreshing,
    error: cache.error,
    reload,
  };
}
