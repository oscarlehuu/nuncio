import { describe, expect, it, beforeEach } from 'bun:test';
import { UsageService } from '../../../src/usage/usage.service';
import type { ProviderUsageFetcher, UsageSnapshotDto } from '../../../src/usage/usage.types';
import { USAGE_FETCHERS } from '../../../src/usage/usage.registry';

describe('UsageService cache', () => {
  const service = new UsageService();

  beforeEach(() => {
    service.clearCache();
  });

  it('returns one snapshot per supported provider', async () => {
    const original = { ...USAGE_FETCHERS };
    let calls = 0;
    const stub: ProviderUsageFetcher = {
      provider: 'claude',
      async fetch() {
        calls += 1;
        return {
          provider: 'claude',
          updatedAt: new Date().toISOString(),
          limits: [{ window: 'Session', usedPercent: 1 }],
          usageLines: [],
          source: 'test',
          status: 'ok',
        };
      },
    };

    // Replace all fetchers with stubs that never hit the network.
    for (const id of Object.keys(USAGE_FETCHERS) as Array<keyof typeof USAGE_FETCHERS>) {
      USAGE_FETCHERS[id] = {
        provider: id,
        async fetch() {
          calls += 1;
          return {
            provider: id,
            updatedAt: new Date().toISOString(),
            limits: [],
            usageLines: [],
            source: 'test',
            status: 'needs-auth',
            detail: 'stub',
          } satisfies UsageSnapshotDto;
        },
      };
    }
    USAGE_FETCHERS.claude = stub;

    try {
      const first = await service.list();
      expect(first).toHaveLength(3);
      expect(first.map((s) => s.provider).sort()).toEqual(['claude', 'codex', 'cursor']);
      expect(first.find((s) => s.provider === 'claude')?.status).toBe('ok');

      const second = await service.list();
      // Claude ok snapshot is TTL-cached; needs-auth fetchers re-run (TTL 0).
      expect(second.find((s) => s.provider === 'claude')?.limits[0]?.usedPercent).toBe(1);
      expect(calls).toBeGreaterThanOrEqual(3);
    } finally {
      Object.assign(USAGE_FETCHERS, original);
    }
  });

  it('keeps the last ok snapshot when a refresh fails', async () => {
    const original = USAGE_FETCHERS.claude;
    let round = 0;
    USAGE_FETCHERS.claude = {
      provider: 'claude',
      async fetch() {
        round += 1;
        if (round === 1) {
          return {
            provider: 'claude',
            updatedAt: new Date().toISOString(),
            limits: [{ window: 'Session', usedPercent: 42 }],
            usageLines: [],
            source: 'test',
            status: 'ok',
          };
        }
        return {
          provider: 'claude',
          updatedAt: new Date().toISOString(),
          limits: [],
          usageLines: [],
          source: 'test',
          status: 'error',
          detail: 'boom',
        };
      },
    };

    try {
      const ok = await service.get('claude', { forceRefresh: true });
      expect(ok.status).toBe('ok');
      expect(ok.limits[0]?.usedPercent).toBe(42);

      const kept = await service.get('claude', { forceRefresh: true });
      expect(kept.status).toBe('ok');
      expect(kept.limits[0]?.usedPercent).toBe(42);
    } finally {
      USAGE_FETCHERS.claude = original;
    }
  });
});
