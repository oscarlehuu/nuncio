import { dayBucket, failureStreak, runsOnDay } from './loop-accounting';
import type { LoopRunDto } from './loops.types';

const VERIFY_TAIL_CAP = 1500;
export const CONTEXT_HEADER = 'Previous run context:';

export interface RunContextInput {
  /** All prior loop_runs (settled + bookkeeping), oldest→newest. */
  runs: LoopRunDto[];
  /** The previous settled run's verify output tail, or null. */
  lastVerifyTail: string | null;
  maxRunsPerDay: number;
  now: number;
}

/** The most recent SETTLED run (ok/failed), or null. */
function lastSettled(runs: LoopRunDto[]): LoopRunDto | null {
  for (let i = runs.length - 1; i >= 0; i -= 1) {
    const o = runs[i]!.outcome;
    if (o === 'ok' || o === 'failed') return runs[i]!;
  }
  return null;
}

/**
 * Build a compact "previous run context" block for the loop's next prompt —
 * lightweight memories v1. Returns '' when there is no prior SETTLED run (the
 * first real run gets the bare goal). Pure over the run history + the last verify
 * tail, so it is deterministic and testable.
 */
export function buildRunContext(input: RunContextInput): string {
  const prev = lastSettled(input.runs);
  if (!prev) return ''; // first run — no context

  const streak = failureStreak(input.runs);
  const todayCount = runsOnDay(input.runs, dayBucket(input.now));
  const lines: string[] = [
    CONTEXT_HEADER,
    `- Previous run: ${prev.outcome}${prev.verify !== 'none' ? ` (verify ${prev.verify})` : ''}`,
    `- Consecutive failures: ${streak}`,
    `- Runs today: ${todayCount}/${input.maxRunsPerDay}`,
  ];
  const tail = input.lastVerifyTail?.trim();
  if (tail) {
    const capped = tail.length > VERIFY_TAIL_CAP ? `${tail.slice(-VERIFY_TAIL_CAP)}` : tail;
    lines.push('- Last verify output (tail):', capped);
  }
  return lines.join('\n');
}

/** Prepend the context block to the goal, delimited; goal unchanged when empty. */
export function withRunContext(goal: string, context: string): string {
  return context ? `${context}\n\n---\n\n${goal}` : goal;
}
