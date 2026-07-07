import type { LoopRunDto } from './loops.types';

/**
 * Pure budget/breaker/stop accounting folded from durable loop_runs rows — no
 * in-memory counters, so a restart rebuilds identical state.
 */

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** Local YYYY-MM-DD for an epoch ms (timezone-naive day bucket, like the scheduler). */
export function dayBucket(now: number): string {
  const d = new Date(now);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Count of runs consumed on `bucket` for the day budget. Bookkeeping rows
 * (`budget-exhausted`, `resume`) do not consume budget; only real runs count.
 */
export function runsOnDay(runs: LoopRunDto[], bucket: string): number {
  return runs.filter(
    (r) => r.dayBucket === bucket && (r.outcome === 'ok' || r.outcome === 'failed'),
  ).length;
}

/**
 * Consecutive-failure streak: trailing `failed` runs since the last `ok`/`resume`
 * (both are fold boundaries). `budget-exhausted` rows are skipped (no signal).
 */
export function failureStreak(runs: LoopRunDto[]): number {
  let streak = 0;
  for (let i = runs.length - 1; i >= 0; i -= 1) {
    const o = runs[i]!.outcome;
    if (o === 'budget-exhausted') continue;
    if (o === 'failed') streak += 1;
    else break; // ok or resume — boundary
  }
  return streak;
}

/** Total real runs (ok + failed) for a maxTotalRuns stop condition. */
export function totalRuns(runs: LoopRunDto[]): number {
  return runs.filter((r) => r.outcome === 'ok' || r.outcome === 'failed').length;
}

/**
 * Consecutive verify-GREEN streak for the verifyGreenN stop. A run counts only
 * when its verify settled GREEN (verify ran and the final verify_result was ok,
 * including green-after-autofix); a RED verify resets it to 0. A run with NO
 * verify signal ('none' — no verify configured, or a bookkeeping row) neither
 * counts nor resets: there's no signal either way, so the streak carries over.
 */
export function verifyGreenStreak(runs: LoopRunDto[]): number {
  let streak = 0;
  for (let i = runs.length - 1; i >= 0; i -= 1) {
    const v = runs[i]!.verify;
    if (v === 'none') continue; // no signal — carry over
    if (v === 'green') streak += 1;
    else break; // red — reset boundary
  }
  return streak;
}
