import { Injectable } from '@nestjs/common';
import { homedir } from 'node:os';
import { loadLocalSpendLines, loadUsageHistory } from './usage-local-spend';
import { errorSnapshot } from './usage-parse';
import { USAGE_FETCHERS } from './usage.registry';
import {
  USAGE_PROVIDER_IDS,
  type ProviderUsageContext,
  type UsageHistoryDto,
  type UsageProviderId,
  type UsageSnapshotDto,
} from './usage.types';

const LIVE_USAGE_TTL_MS = 60_000;

interface CacheEntry {
  expiresAtMs: number;
  value: UsageSnapshotDto | null;
  pending: Promise<UsageSnapshotDto> | null;
}

@Injectable()
export class UsageService {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly requestGenerations = new Map<string, number>();

  buildContext(overrides: Partial<ProviderUsageContext> = {}): ProviderUsageContext {
    return {
      homeDir: overrides.homeDir ?? homedir(),
      env: overrides.env ?? process.env,
      platform: overrides.platform ?? process.platform,
      nowMs: overrides.nowMs ?? Date.now(),
    };
  }

  async list(options: { forceRefresh?: boolean } = {}): Promise<UsageSnapshotDto[]> {
    const ctx = this.buildContext();
    const settled = await Promise.allSettled(
      USAGE_PROVIDER_IDS.map((provider) => this.fetchCached(provider, ctx, options)),
    );
    return settled.map((result, index) => {
      if (result.status === 'fulfilled') {
        return result.value;
      }
      const provider = USAGE_PROVIDER_IDS[index]!;
      return errorSnapshot(provider, ctx.nowMs, 'live-usage', 'Usage fetch failed unexpectedly.');
    });
  }

  async get(
    provider: UsageProviderId,
    options: { forceRefresh?: boolean } = {},
  ): Promise<UsageSnapshotDto> {
    return this.fetchCached(provider, this.buildContext(), options);
  }

  async history(
    options: { days?: number; forceRefresh?: boolean } = {},
  ): Promise<UsageHistoryDto> {
    const days = options.days ?? 30;
    return loadUsageHistory(this.buildContext(), days, {
      forceRefresh: options.forceRefresh,
    });
  }

  /** Test/helper: clear the in-memory TTL cache. */
  clearCache(): void {
    this.cache.clear();
    this.requestGenerations.clear();
  }

  private async enrichWithLocalSpend(
    snapshot: UsageSnapshotDto,
    ctx: ProviderUsageContext,
    options: { forceRefresh?: boolean },
  ): Promise<UsageSnapshotDto> {
    if (snapshot.status !== 'ok') {
      return snapshot;
    }
    const localLines = await loadLocalSpendLines(snapshot.provider, ctx, options);
    if (localLines.length === 0) {
      return snapshot;
    }
    const withoutLocal = snapshot.usageLines.filter(
      (line) => line.label !== 'Today' && line.label !== 'Last 30 Days',
    );
    return { ...snapshot, usageLines: [...withoutLocal, ...localLines] };
  }

  private async fetchCached(
    provider: UsageProviderId,
    ctx: ProviderUsageContext,
    options: { forceRefresh?: boolean },
  ): Promise<UsageSnapshotDto> {
    const fetcher = USAGE_FETCHERS[provider];
    const cacheKey = `${provider}:${ctx.homeDir}`;
    const existing = this.cache.get(cacheKey);

    if (!options.forceRefresh && existing?.value && existing.expiresAtMs > ctx.nowMs) {
      return existing.value;
    }
    if (!options.forceRefresh && existing?.pending) {
      return existing.pending;
    }

    const previousOk = existing?.value?.status === 'ok' ? existing.value : null;
    const generation = (this.requestGenerations.get(cacheKey) ?? 0) + 1;
    this.requestGenerations.set(cacheKey, generation);
    const isLatestRequest = () => this.requestGenerations.get(cacheKey) === generation;

    const pending = fetcher
      .fetch(ctx)
      .catch(() =>
        errorSnapshot(provider, ctx.nowMs, 'live-usage', 'Usage fetch failed unexpectedly.'),
      )
      .then(async (value) => {
        const status = value.status;
        if (status !== 'ok' && previousOk) {
          if (isLatestRequest()) {
            this.cache.set(cacheKey, {
              expiresAtMs: Date.now() + LIVE_USAGE_TTL_MS,
              value: previousOk,
              pending: null,
            });
          }
          return previousOk;
        }
        const enriched = await this.enrichWithLocalSpend(value, ctx, options);
        if (isLatestRequest()) {
          this.cache.set(cacheKey, {
            expiresAtMs: status === 'ok' ? Date.now() + LIVE_USAGE_TTL_MS : 0,
            value: enriched,
            pending: null,
          });
        }
        return enriched;
      });

    this.cache.set(cacheKey, {
      expiresAtMs: existing?.expiresAtMs ?? 0,
      value: existing?.value ?? null,
      pending,
    });

    return pending;
  }
}
