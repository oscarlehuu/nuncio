import { Injectable, Optional, type OnModuleInit } from '@nestjs/common';
import type { Clock } from '../../scheduler/scheduler.types';
import { SettingsService } from '../../settings/settings.service';
import { SessionsRepository } from '../../sessions/persistence/sessions.repository';
import { GitService } from '../../git/git.service';
import { LoopsService } from '../../loops/loops.service';
import { dayBucket } from '../../loops/loop-accounting';
import { AttentionService } from '../attention.service';
import { AttentionCollectors } from '../attention-collectors';

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
export class AnomalyCollector implements OnModuleInit {
  clock: Clock = { now: () => Date.now() };
  emptyDiffAgeMs = DEFAULT_EMPTY_DIFF_AGE_MS;
  loopFailingMinRuns = DEFAULT_LOOP_FAILING_MIN_RUNS;

  /** Test/wiring seam: current RUNNING sessions to inspect for (a). */
  runningSessions: () => RunningSessionInput[] = () => [];
  /** Test/wiring seam: does the worktree at `path` have uncommitted changes? */
  hasChanges: (path: string) => Promise<boolean> = async () => false;
  /** Test/wiring seam: today's runs per loop for (b). */
  loopsToday: () => LoopTodayInput[] = () => [];

  constructor(
    @Optional() private readonly attention?: AttentionService,
    @Optional() private readonly settings?: SettingsService,
    @Optional() private readonly sessions?: SessionsRepository,
    @Optional() private readonly git?: GitService,
    @Optional() private readonly loops?: LoopsService,
    @Optional() private readonly collectors?: AttentionCollectors,
  ) {}

  onModuleInit(): void {
    this.bindThresholds();
    this.bindDataSeams();
    // Ride the existing sweep cadence (heartbeat 15m infra sweep drives it).
    this.collectors?.registerSweep(() => this.sweep());
  }

  private bindThresholds(): void {
    const t = Number(this.settings?.resolve('NUNCIO_ANOMALY_EMPTY_DIFF_MIN'));
    if (Number.isInteger(t) && t > 0) this.emptyDiffAgeMs = t * 60_000;
    const n = Number(this.settings?.resolve('NUNCIO_ANOMALY_LOOP_FAILING_RUNS'));
    if (Number.isInteger(n) && n > 0) this.loopFailingMinRuns = n;
  }

  private bindDataSeams(): void {
    if (this.sessions) {
      this.runningSessions = () =>
        this.sessions!
          .listUserFacing(false)
          .filter((s) => s.status === 'RUNNING')
          .map((s) => ({
            id: s.id,
            projectPath: s.projectPath ?? null,
            gitDir: s.worktreePath ?? s.workspace ?? s.projectPath ?? null,
            // Silent-for = time since the last state change; pairs with empty-diff.
            runningForMs: this.clock.now() - s.updatedAt,
          }));
    }
    if (this.git) this.hasChanges = (path) => this.git!.hasChanges(path);
    if (this.loops) {
      this.loopsToday = () => {
        const today = dayBucket(this.clock.now());
        return this.loops!.list().map((loop) => ({
          loopId: loop.id,
          projectPath: loop.projectPath,
          runs: this.loops!.runs(loop.id)
            .filter((r) => r.dayBucket === today)
            .map((r) => ({ outcome: r.outcome, verify: r.verify })),
        }));
      };
    }
  }

  /** Run both heuristics: raise anomalies + clear cleared ones through the A seam. */
  async sweep(): Promise<void> {
    await this.collectEmptyDiff();
    this.collectLoopFailing();
  }

  /**
   * (a) session-empty-diff: a session RUNNING > T whose worktree has NO changes is
   * anomalous. CLEAR-path: a session that no longer qualifies (diff appeared, or
   * dropped out of RUNNING) has its item resolved — so an item never stales.
   */
  async collectEmptyDiff(): Promise<void> {
    if (!this.attention) return;
    const sessions = this.runningSessions();
    const present = new Set(sessions.map((s) => s.id));

    for (const s of sessions) {
      const subjectId = `session:${s.id}`;
      const overAge = s.runningForMs > this.emptyDiffAgeMs; // strict boundary
      const emptyDiff = overAge && s.gitDir ? !(await this.hasChanges(s.gitDir)) : false;
      if (overAge && emptyDiff) {
        this.attention.raise({
          kind: 'session-empty-diff',
          subjectId,
          projectPath: s.projectPath,
          title: 'Session running long with no changes',
          payload: { sessionId: s.id },
        });
      } else {
        // Still running but now productive (or not yet over-age) → clear.
        this.attention.onConditionCleared('session-empty-diff', subjectId);
      }
    }

    // A session that left RUNNING entirely no longer appears above — clear its
    // open item (finished/errored → condition gone).
    for (const item of this.attention.list().items) {
      if (item.kind !== 'session-empty-diff') continue;
      const sessionId = item.subjectId.replace(/^session:/, '');
      if (!present.has(sessionId)) this.attention.onConditionCleared('session-empty-diff', item.subjectId);
    }
  }

  /**
   * (b) loop-failing: a loop with >= N today runs, ALL failed/budget-exhausted and
   * NO green-verify run today, is anomalous. CLEAR-path: a green run lands (or the
   * loop drops out of today's set entirely) → item resolved.
   */
  collectLoopFailing(): void {
    if (!this.attention) return;
    const loops = this.loopsToday();
    const present = new Set(loops.map((l) => l.loopId));

    for (const loop of loops) {
      const subjectId = `loop:${loop.loopId}`;
      const failedRuns = loop.runs.filter(
        (r) => r.outcome === 'failed' || r.outcome === 'budget-exhausted',
      ).length;
      const anyGreen = loop.runs.some((r) => r.verify === 'green' || r.outcome === 'ok');
      // A still-PENDING run is not settled — it could yet go green, so don't cry
      // wolf while one is in flight. Bookkeeping rows (skipped-overlap, resume)
      // stay transparent as everywhere else — they neither count nor block.
      const anyPending = loop.runs.some((r) => r.outcome === 'pending');
      const failing = failedRuns >= this.loopFailingMinRuns && !anyGreen && !anyPending;
      if (failing) {
        this.attention.raise({
          kind: 'loop-failing',
          subjectId,
          projectPath: loop.projectPath,
          title: 'Loop failing all runs today',
          payload: { loopId: loop.loopId },
        });
      } else {
        this.attention.onConditionCleared('loop-failing', subjectId);
      }
    }

    // A loop that dropped out of today's set (rollover / deleted) → clear.
    for (const item of this.attention.list().items) {
      if (item.kind !== 'loop-failing') continue;
      const loopId = item.subjectId.replace(/^loop:/, '');
      if (!present.has(loopId)) this.attention.onConditionCleared('loop-failing', item.subjectId);
    }
  }
}
