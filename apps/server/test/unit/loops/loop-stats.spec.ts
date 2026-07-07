import { describe, expect, it } from 'bun:test';
import { computeLoopStats } from '../../../src/loops/loop-stats';
import type { LoopDto, LoopRunDto, LoopRunOutcome, LoopStatus } from '../../../src/loops/loops.types';

function at(y: number, mo: number, d: number, h: number, mi: number): number {
  return new Date(y, mo - 1, d, h, mi, 0, 0).getTime();
}

let seq = 0;
function run(outcome: LoopRunOutcome, createdAt: number): LoopRunDto {
  seq += 1;
  return { id: `r${seq}`, loopId: 'L', taskId: `t${seq}`, outcome, verify: 'none', dayBucket: 'x', createdAt };
}

function loop(status: LoopStatus): LoopDto {
  seq += 1;
  return {
    id: `L${seq}`, name: null, goal: 'g', scheduleId: 's', maxRunsPerDay: 5, maxConsecutiveFailures: 3,
    stop: null, escalation: 'needs-attention', projectPath: null, engine: null, status, createdAt: 0, updatedAt: 0,
  };
}

const now = at(2026, 7, 14, 12, 0);

describe('computeLoopStats', () => {
  it('returns zeros and a 14-day sparkline for an empty fleet', () => {
    const stats = computeLoopStats([], [], now);
    expect(stats).toMatchObject({ total: 0, active: 0, broken: 0, successful7d: 0, failed7d: 0 });
    expect(stats.sparkline).toHaveLength(14);
    expect(stats.sparkline.every((d) => d.ok === 0 && d.failed === 0)).toBe(true);
  });

  it('counts loops by status', () => {
    const stats = computeLoopStats([loop('active'), loop('active'), loop('broken'), loop('paused')], [], now);
    expect(stats.total).toBe(4);
    expect(stats.active).toBe(2);
    expect(stats.broken).toBe(1);
  });

  it('counts settled ok/failed in the 7d and 24h windows', () => {
    const runs = [
      run('ok', now - 2 * 24 * 3600_000), // 2d ago
      run('failed', now - 2 * 24 * 3600_000),
      run('ok', now - 30 * 60_000), // 30m ago (in 24h)
      run('failed', now - 30 * 60_000),
      run('ok', now - 10 * 24 * 3600_000), // 10d ago (outside 7d)
    ];
    const stats = computeLoopStats([], runs, now);
    expect(stats.successful7d).toBe(2); // 2d + 30m
    expect(stats.failed7d).toBe(2);
    expect(stats.successful24h).toBe(1); // only 30m
    expect(stats.failed24h).toBe(1);
  });

  it('excludes non-settled outcomes (pending / skipped-overlap / budget-exhausted / resume)', () => {
    const runs = [
      run('pending', now - 60_000),
      run('skipped-overlap', now - 60_000),
      run('budget-exhausted', now - 60_000),
      run('resume', now - 60_000),
      run('ok', now - 60_000),
    ];
    const stats = computeLoopStats([], runs, now);
    expect(stats.successful24h).toBe(1);
    expect(stats.failed24h).toBe(0);
  });

  it('buckets settled runs into the sparkline by local day', () => {
    const runs = [run('ok', now), run('ok', now), run('failed', now)];
    const stats = computeLoopStats([], runs, now);
    const today = stats.sparkline[stats.sparkline.length - 1]!;
    expect(today.ok).toBe(2);
    expect(today.failed).toBe(1);
  });
});
