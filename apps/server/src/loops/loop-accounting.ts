import type { LoopRunDto } from './loops.types';

/**
 * Pure budget/breaker accounting folded from durable loop_runs rows — no
 * in-memory counters, so a restart rebuilds identical state. SKELETON: the red
 * suite drives the contract; functions throw until implemented.
 */

/** Local YYYY-MM-DD for an epoch ms (timezone-naive day bucket, like the scheduler). */
export function dayBucket(_now: number): string {
  throw new Error('TODO: dayBucket unimplemented');
}

/** Count of runs whose day_bucket equals `bucket` (today's run count for the day budget). */
export function runsOnDay(_runs: LoopRunDto[], _bucket: string): number {
  throw new Error('TODO: runsOnDay unimplemented');
}

/**
 * Consecutive-failure streak: trailing `failed` runs since the last `ok`/`resume`
 * (both are fold boundaries). `budget-exhausted` rows do not count as failures.
 */
export function failureStreak(_runs: LoopRunDto[]): number {
  throw new Error('TODO: failureStreak unimplemented');
}

/** Total non-bookkeeping runs (ok + failed) for a maxTotalRuns stop condition. */
export function totalRuns(_runs: LoopRunDto[]): number {
  throw new Error('TODO: totalRuns unimplemented');
}
