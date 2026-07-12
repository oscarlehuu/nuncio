import { describe, expect, it, beforeEach } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UsageService } from '../../../src/usage/usage.service';
import { clearLocalSpendCache } from '../../../src/usage/usage-local-spend';
import type { ProviderUsageFetcher, UsageSnapshotDto } from '../../../src/usage/usage.types';
import { USAGE_FETCHERS } from '../../../src/usage/usage.registry';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function okSnapshot(usedPercent: number): UsageSnapshotDto {
  return {
    provider: 'claude',
    updatedAt: new Date().toISOString(),
    limits: [{ window: 'Session', usedPercent }],
    usageLines: [],
    source: 'test',
    status: 'ok',
  };
}

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

  it('force refresh bypasses the local-spend cache as well as the live quota cache', async () => {
    const root = mkdtempSync(join(tmpdir(), 'nuncio-usage-service-'));
    const projectDir = join(root, '.claude', 'projects', 'demo');
    const transcript = join(projectDir, 'session.jsonl');
    const now = Date.now();
    const frozen = new Date(now - 60_000);
    const original = USAGE_FETCHERS.claude;
    mkdirSync(projectDir, { recursive: true });

    const writeUsage = (tokens: number) => {
      writeFileSync(
        transcript,
        `${JSON.stringify({
          type: 'assistant',
          timestamp: new Date(now - 1_000).toISOString(),
          requestId: `request-${tokens}`,
          message: { id: `message-${tokens}`, usage: { input_tokens: tokens, output_tokens: 0 } },
        })}\n`,
        'utf8',
      );
      utimesSync(transcript, frozen, frozen);
    };

    USAGE_FETCHERS.claude = { provider: 'claude', async fetch() { return okSnapshot(1); } };
    const localService = new UsageService();
    localService.buildContext = () => ({
      homeDir: root,
      env: {},
      platform: process.platform,
      nowMs: now,
    });

    try {
      clearLocalSpendCache();
      writeUsage(15);
      const first = await localService.get('claude', { forceRefresh: true });
      expect(first.usageLines.find((line) => line.label === 'Today')?.value).toContain('15');

      writeUsage(1_000);
      const refreshed = await localService.get('claude', { forceRefresh: true });
      expect(refreshed.usageLines.find((line) => line.label === 'Today')?.value).toMatch(/1(?:,|\.)?000|1K/i);
    } finally {
      clearLocalSpendCache();
      USAGE_FETCHERS.claude = original;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not let an older forced probe overwrite a newer completed refresh', async () => {
    const original = USAGE_FETCHERS.claude;
    const first = deferred<UsageSnapshotDto>();
    const second = deferred<UsageSnapshotDto>();
    let calls = 0;
    USAGE_FETCHERS.claude = {
      provider: 'claude',
      fetch() {
        calls += 1;
        return calls === 1 ? first.promise : second.promise;
      },
    };

    try {
      const olderRequest = service.get('claude', { forceRefresh: true });
      const newerRequest = service.get('claude', { forceRefresh: true });

      second.resolve(okSnapshot(22));
      expect((await newerRequest).limits[0]?.usedPercent).toBe(22);
      first.resolve(okSnapshot(11));
      expect((await olderRequest).limits[0]?.usedPercent).toBe(11);

      const cached = await service.get('claude');
      expect(cached.limits[0]?.usedPercent).toBe(22);
    } finally {
      USAGE_FETCHERS.claude = original;
    }
  });
});
