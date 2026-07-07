import { describe, expect, it } from 'bun:test';
import {
  dayBucket,
  failureStreak,
  runsOnDay,
  totalRuns,
} from '../../../src/loops/loop-accounting';
import type { LoopRunDto, LoopRunOutcome } from '../../../src/loops/loops.types';

/**
 * Pure budget/breaker accounting folded from durable loop_runs — restart-safe.
 * RED until implemented. Deterministic: time / rows passed in explicitly.
 */

let seq = 0;
function run(outcome: LoopRunOutcome, dayBucketStr = '2026-07-07'): LoopRunDto {
  seq += 1;
  return {
    id: `r${seq}`,
    loopId: 'L',
    taskId: `t${seq}`,
    outcome,
    dayBucket: dayBucketStr,
    createdAt: seq,
  };
}

function at(y: number, mo: number, d: number, h: number, mi: number): number {
  return new Date(y, mo - 1, d, h, mi, 0, 0).getTime();
}

describe('dayBucket (timezone-naive local YYYY-MM-DD)', () => {
  it('formats the local date', () => {
    expect(dayBucket(at(2026, 7, 7, 8, 0))).toBe('2026-07-07');
    expect(dayBucket(at(2026, 1, 3, 23, 59))).toBe('2026-01-03');
  });

  it('rolls the bucket at local midnight', () => {
    expect(dayBucket(at(2026, 7, 7, 23, 59))).toBe('2026-07-07');
    expect(dayBucket(at(2026, 7, 8, 0, 0))).toBe('2026-07-08');
  });
});

describe('runsOnDay (day budget count)', () => {
  it('counts only runs in the given day bucket', () => {
    const runs = [run('ok', '2026-07-07'), run('failed', '2026-07-07'), run('ok', '2026-07-08')];
    expect(runsOnDay(runs, '2026-07-07')).toBe(2);
    expect(runsOnDay(runs, '2026-07-08')).toBe(1);
    expect(runsOnDay(runs, '2026-07-09')).toBe(0);
  });

  it('budget-exhausted bookkeeping rows still count against the day (a fire attempt)', () => {
    const runs = [run('ok'), run('budget-exhausted')];
    // Design: the day-count is "runs consumed today"; ok + failed count, exhausted
    // is a skip marker and does NOT consume budget.
    expect(runsOnDay(runs.filter((r) => r.outcome !== 'budget-exhausted'), '2026-07-07')).toBe(1);
  });
});

describe('failureStreak (trailing failed since last ok/resume)', () => {
  it('is zero with no runs or after an ok', () => {
    expect(failureStreak([])).toBe(0);
    expect(failureStreak([run('failed'), run('ok')])).toBe(0);
  });

  it('counts trailing failures', () => {
    expect(failureStreak([run('ok'), run('failed'), run('failed')])).toBe(2);
  });

  it('an ok mid-streak resets it (fail, fail, ok, fail -> 1)', () => {
    expect(failureStreak([run('failed'), run('failed'), run('ok'), run('failed')])).toBe(1);
  });

  it('a resume row is a fold boundary (fail, fail, resume, fail -> 1)', () => {
    expect(failureStreak([run('failed'), run('failed'), run('resume'), run('failed')])).toBe(1);
  });

  it('budget-exhausted rows do not count as failures nor reset the streak', () => {
    expect(failureStreak([run('failed'), run('budget-exhausted'), run('failed')])).toBe(2);
  });
});

describe('totalRuns (for maxTotalRuns stop condition)', () => {
  it('counts ok + failed, ignoring bookkeeping rows', () => {
    const runs = [run('ok'), run('failed'), run('budget-exhausted'), run('resume'), run('ok')];
    expect(totalRuns(runs)).toBe(3);
  });
});
