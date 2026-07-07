import { Injectable, Optional } from '@nestjs/common';
import type { Clock } from '../../scheduler/scheduler.types';
import { AttentionService } from '../attention.service';

/** Default: a RUNNING session must be silent-with-empty-diff this long to flag (a). */
export const DEFAULT_EMPTY_DIFF_AGE_MS = 30 * 60 * 1000;
/** Default: a loop must have this many all-failed runs today to flag (b). */
export const DEFAULT_LOOP_FAILING_MIN_RUNS = 3;

/** A RUNNING session the empty-diff heuristic inspects. */
export interface RunningSessionInput {
  id: string;
  projectPath: string | null;
  /** Git dir to check for changes (worktree, else workspace). Null → skip. */
  gitDir: string | null;
  /** How long the session has been RUNNING (ms). */
  runningForMs: number;
}

/** Today's loop-run outcomes for one loop (the failing heuristic folds these). */
export interface LoopTodayInput {
  loopId: string;
  projectPath: string | null;
  /** Today's runs, oldest→newest: settled outcome + verify signal. */
  runs: Array<{ outcome: string; verify: 'green' | 'red' | 'none' }>;
}

/**
 * Anomaly heuristics (rung 3, sub-phase C) — EXACTLY two, both raising through the
 * sub-phase A seam as bottom-bucket kinds, both with a CLEAR-path (the sub-phase-B
 * lesson: every raiser is paired with a clearer, so an item never stales):
 *
 *  (a) session-empty-diff — a session RUNNING > T with an EMPTY worktree diff.
 *  (b) loop-failing — a loop with >= N today runs ALL failed/budget, no green.
 *
 * Rides the existing 15-min infra sweep. Seams (settable) keep it unit-testable
 * without the session/git/loop graph. RED until implemented — neutral TODO throws.
 */
@Injectable()
export class AnomalyCollector {
  clock: Clock = { now: () => Date.now() };
  emptyDiffAgeMs = DEFAULT_EMPTY_DIFF_AGE_MS;
  loopFailingMinRuns = DEFAULT_LOOP_FAILING_MIN_RUNS;

  /** Test/wiring seam: current RUNNING sessions to inspect for (a). */
  runningSessions: () => RunningSessionInput[] = () => [];
  /** Test/wiring seam: does the worktree at `path` have uncommitted changes? */
  hasChanges: (path: string) => Promise<boolean> = async () => false;
  /** Test/wiring seam: today's runs per loop for (b). */
  loopsToday: () => LoopTodayInput[] = () => [];

  constructor(@Optional() private readonly attention?: AttentionService) {}

  /** Run both heuristics: raise anomalies + clear cleared ones through the A seam. */
  async sweep(): Promise<void> {
    throw new Error('TODO: AnomalyCollector.sweep not implemented');
  }

  /** (a) RUNNING > T with an empty diff → session-empty-diff (else clear). */
  async collectEmptyDiff(): Promise<void> {
    throw new Error('TODO: AnomalyCollector.collectEmptyDiff not implemented');
  }

  /** (b) >= N today runs all failed/budget, no green → loop-failing (else clear). */
  collectLoopFailing(): void {
    throw new Error('TODO: AnomalyCollector.collectLoopFailing not implemented');
  }
}
