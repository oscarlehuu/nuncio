import { dayBucket } from './loop-accounting';
import type { LoopDto, LoopRunDto, LoopStatus } from './loops.types';

export interface LoopStats {
  total: number;
  active: number;
  broken: number;
  successful7d: number;
  failed7d: number;
  successful24h: number;
  failed24h: number;
  sparkline: Array<{ day: string; ok: number; failed: number }>;
}

const DAY_MS = 24 * 60 * 60_000;
const SPARK_DAYS = 14;

function countBy(status: LoopStatus, loops: LoopDto[]): number {
  return loops.filter((l) => l.status === status).length;
}

/**
 * Derive fleet loop stats from SETTLED run outcomes only (ok/failed) — pending,
 * skipped-overlap, budget-exhausted, and resume are excluded. Pure over the run
 * set + clock, so it is deterministic and testable.
 */
export function computeLoopStats(loops: LoopDto[], runs: LoopRunDto[], now: number): LoopStats {
  const settled = runs.filter((r) => r.outcome === 'ok' || r.outcome === 'failed');
  const since7d = now - 7 * DAY_MS;
  const since24h = now - DAY_MS;

  const inWindow = (r: LoopRunDto, since: number) => r.createdAt >= since;
  const ok = (r: LoopRunDto) => r.outcome === 'ok';
  const failed = (r: LoopRunDto) => r.outcome === 'failed';

  // 14-day sparkline, oldest→newest, keyed by local day bucket.
  const sparkline: LoopStats['sparkline'] = [];
  for (let i = SPARK_DAYS - 1; i >= 0; i -= 1) {
    const day = dayBucket(now - i * DAY_MS);
    const dayRuns = settled.filter((r) => dayBucket(r.createdAt) === day);
    sparkline.push({
      day,
      ok: dayRuns.filter(ok).length,
      failed: dayRuns.filter(failed).length,
    });
  }

  return {
    total: loops.length,
    active: countBy('active', loops),
    broken: countBy('broken', loops),
    successful7d: settled.filter((r) => ok(r) && inWindow(r, since7d)).length,
    failed7d: settled.filter((r) => failed(r) && inWindow(r, since7d)).length,
    successful24h: settled.filter((r) => ok(r) && inWindow(r, since24h)).length,
    failed24h: settled.filter((r) => failed(r) && inWindow(r, since24h)).length,
    sparkline,
  };
}
