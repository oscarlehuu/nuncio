import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  USAGE_CACHE_TTL_MS,
  ensureUsageCache,
  getUsageCacheState,
  isUsageCacheFresh,
  resetUsageCacheForTests,
  seedUsageCacheForTests,
  subscribeUsageCache,
} from './usage-cache';
import * as usageApi from './usage-api';

vi.mock('./usage-api', () => ({
  fetchProviderUsage: vi.fn(async () => [
    {
      provider: 'claude',
      updatedAt: '2026-07-11T10:00:00.000Z',
      limits: [{ window: 'Session', usedPercent: 3 }],
      usageLines: [],
      source: 'test',
      status: 'ok',
    },
  ]),
  fetchUsageHistory: vi.fn(async () => ({
    days: [{ date: '2026-07-11', claude: 100, codex: 0, cursor: 0 }],
    totals: { claude: 100, codex: 0, cursor: 0 },
    estimatedUsdTotals: { claude: 0.0005, codex: 0, cursor: 0 },
    updatedAt: '2026-07-11T10:00:00.000Z',
  })),
}));

describe('usage-cache', () => {
  let now = 1_000_000;

  beforeEach(() => {
    now = 1_000_000;
    resetUsageCacheForTests({ now: () => now });
    vi.clearAllMocks();
  });

  afterEach(() => {
    resetUsageCacheForTests();
  });

  it('treats fetchedAt within TTL as fresh', () => {
    expect(isUsageCacheFresh(now - 1_000, USAGE_CACHE_TTL_MS, now)).toBe(true);
    expect(isUsageCacheFresh(now - USAGE_CACHE_TTL_MS - 1, USAGE_CACHE_TTL_MS, now)).toBe(false);
    expect(isUsageCacheFresh(null, USAGE_CACHE_TTL_MS, now)).toBe(false);
  });

  it('skips network when cache is still fresh', async () => {
    seedUsageCacheForTests({
      snapshots: [
        {
          provider: 'claude',
          updatedAt: '2026-07-11T10:00:00.000Z',
          limits: [],
          usageLines: [],
          source: 'seed',
          status: 'ok',
        },
      ],
      fetchedAt: now,
    });

    await ensureUsageCache({ force: false });
    expect(usageApi.fetchProviderUsage).not.toHaveBeenCalled();
    expect(getUsageCacheState().snapshots[0]?.source).toBe('seed');
  });

  it('pulls when TTL expired', async () => {
    seedUsageCacheForTests({
      snapshots: [],
      fetchedAt: now - USAGE_CACHE_TTL_MS - 1,
    });

    await ensureUsageCache({ force: false });
    expect(usageApi.fetchProviderUsage).toHaveBeenCalledTimes(1);
    expect(getUsageCacheState().fetchedAt).toBe(now);
    expect(getUsageCacheState().snapshots).toHaveLength(1);
  });

  it('force=true always pulls (and asks server to bypass cache)', async () => {
    seedUsageCacheForTests({
      snapshots: [],
      fetchedAt: now,
    });

    await ensureUsageCache({ force: true });
    expect(usageApi.fetchProviderUsage).toHaveBeenCalledWith({ forceRefresh: true });
  });

  it('loads history only when requested and stale', async () => {
    seedUsageCacheForTests({
      snapshots: [],
      fetchedAt: now,
      history: null,
      historyFetchedAt: null,
    });

    await ensureUsageCache({ force: false, history: true });
    // snapshots fresh → skip; history missing → fetch
    expect(usageApi.fetchProviderUsage).not.toHaveBeenCalled();
    expect(usageApi.fetchUsageHistory).toHaveBeenCalledTimes(1);

    await ensureUsageCache({ force: false, history: true });
    expect(usageApi.fetchUsageHistory).toHaveBeenCalledTimes(1);
  });

  it('notifies subscribers when a real pull updates state', async () => {
    const listener = vi.fn();
    const unsub = subscribeUsageCache(listener);

    await ensureUsageCache({ force: false });
    expect(listener).toHaveBeenCalled();
    unsub();
  });
});
