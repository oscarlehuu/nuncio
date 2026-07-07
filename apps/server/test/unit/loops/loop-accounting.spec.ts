import { describe, expect, it } from 'bun:test';
import {
  dayBucket,
  failureStreak,
  runsOnDay,
  totalRuns,
  verifyGreenStreak,
} from '../../../src/loops/loop-accounting';
import type { LoopRunDto, LoopRunOutcome, LoopRunVerify } from '../../../src/loops/loops.types';

/**
 * Pure budget/breaker accounting folded from durable loop_runs — restart-safe.
 * Deterministic: time / rows passed in explicitly.
 */

let seq = 0;
function run(
  outcome: LoopRunOutcome,
  dayBucketStr = '2026-07-07',
  verify: LoopRunVerify = outcome === 'ok' ? 'green' : 'none',
): LoopRunDto {
  seq += 1;
  return {
    id: `r${seq}`,
    loopId: 'L',
    taskId: `t${seq}`,
    outcome,
    verify,
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

  it('bookkeeping rows (budget-exhausted, resume) do NOT consume budget', () => {
    const runs = [run('ok'), run('budget-exhausted'), run('resume')];
    expect(runsOnDay(runs, '2026-07-07')).toBe(1);
  });

  it('a pending (in-flight) run consumes a day slot — a fire happened', () => {
    // Prevents double-firing while a run is still settling.
    const runs = [run('ok'), run('pending')];
    expect(runsOnDay(runs, '2026-07-07')).toBe(2);
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

  it('a still-pending (unsettled) run is transparent — no settled signal yet', () => {
    // fail, fail, pending -> the pending run carries the streak (2), not a reset.
    expect(failureStreak([run('failed'), run('failed'), run('pending')])).toBe(2);
  });
});

describe('totalRuns (for maxTotalRuns stop condition)', () => {
  it('counts ok + failed, ignoring bookkeeping rows', () => {
    const runs = [run('ok'), run('failed'), run('budget-exhausted'), run('resume'), run('ok')];
    expect(totalRuns(runs)).toBe(3);
  });
});

describe('verifyGreenStreak (for verifyGreenN stop)', () => {
  const green = () => run('ok', '2026-07-07', 'green');
  const red = () => run('failed', '2026-07-07', 'red');
  const noVerify = () => run('ok', '2026-07-07', 'none');

  it('is zero with no runs', () => {
    expect(verifyGreenStreak([])).toBe(0);
  });

  it('counts trailing consecutive green-verify runs', () => {
    expect(verifyGreenStreak([green(), green(), green()])).toBe(3);
  });

  it('a red verify resets the streak', () => {
    expect(verifyGreenStreak([green(), green(), red(), green()])).toBe(1);
  });

  it('a run with NO verify signal carries the streak over (neither counts nor resets)', () => {
    // green, green, no-verify, green -> the no-verify run is transparent, so 3 greens.
    expect(verifyGreenStreak([green(), green(), noVerify(), green()])).toBe(3);
  });

  it('a no-verify run does not resurrect a broken streak', () => {
    // green, red (reset), no-verify -> streak stays 0 (no-verify carries over the 0).
    expect(verifyGreenStreak([green(), red(), noVerify()])).toBe(0);
  });

  it('bookkeeping rows (resume/budget-exhausted) are verify:none and transparent', () => {
    expect(verifyGreenStreak([green(), run('resume', '2026-07-07', 'none'), green()])).toBe(2);
  });
});
