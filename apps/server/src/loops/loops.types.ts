export type LoopStatus = 'active' | 'paused' | 'broken' | 'completed';

/**
 * Run-success outcome. A run is born `pending` (task enqueued, not yet settled);
 * settlement finalizes it to `ok`/`failed`. `budget-exhausted`, `resume`, and
 * `skipped-overlap` are transparent bookkeeping rows (they consume no day budget
 * and never touch the failure/verify streaks). Only settled runs (ok/failed) feed
 * the streak/total-runs folds. `pending` consumes a day slot but is streak-neutral.
 *
 * CLIENT NOTE: the UI's CONSUMED_OUTCOMES set is {pending, ok, failed} — the
 * `skipped-overlap` marker is OUTSIDE it (transparent to day count + streaks).
 */
export type LoopRunOutcome =
  | 'pending'
  | 'ok'
  | 'failed'
  | 'budget-exhausted'
  | 'skipped-overlap'
  | 'resume';

/**
 * The verify signal for a run (feeds the verifyGreenN stop):
 *   'green' — verify ran and the final verify_result was ok (incl. green-after-autofix)
 *   'red'   — verify ran and stayed failing (rung-1 exhausted / task failed)
 *   'none'  — no verify configured, OR a bookkeeping row (no signal either way)
 */
export type LoopRunVerify = 'green' | 'red' | 'none';

/**
 * Stop condition v1 (founder-locked): null = standing (run until paused) |
 * maxTotalRuns | verifyGreenN (complete after n consecutive green-verify runs).
 */
export type StopCondition =
  | null
  | { kind: 'maxTotalRuns'; n: number }
  | { kind: 'verifyGreenN'; n: number };

export interface LoopDto {
  id: string;
  /** Optional human label (v1.1). Null = fall back to the goal for display. */
  name: string | null;
  /** (1) goal — the prompt each run enqueues. */
  goal: string;
  /** (2) trigger — the loop OWNS this schedules row. */
  scheduleId: string;
  /**
   * The human-displayable trigger, joined from the owned schedule row (UI shows
   * "Daily at 22:00"). Null when the schedule row is missing/corrupt — never a
   * throw. Additive: absent on the bare repository DTO, filled on the read path.
   */
  schedule?: { kind: string; spec: string } | null;
  /** Next fire time (epoch ms), joined from the schedule; null for event/none. */
  nextFireAt?: number | null;
  /** (3) budget. */
  maxRunsPerDay: number;
  maxConsecutiveFailures: number;
  /** (4) stop condition. */
  stop: StopCondition;
  /** (5) escalation policy (v1: 'needs-attention'). */
  escalation: string;
  projectPath: string | null;
  /** Per-loop engine override (v1.1). Null = inherit project/registry default. */
  engine: string | null;
  /** Per-loop model override (v1.2). Null = the resolved engine's default model. */
  model: string | null;
  status: LoopStatus;
  createdAt: number;
  updatedAt: number;
}

export interface CreateLoopDto {
  /** Optional human label. Null/omitted → displayed as the goal. */
  name?: string | null;
  goal: string;
  /** Trigger spec — the loop creates + owns a schedule from this. */
  schedule: { kind: 'cron' | 'heartbeat' | 'event'; spec: string };
  maxRunsPerDay?: number;
  maxConsecutiveFailures?: number;
  stop?: StopCondition;
  projectPath?: string;
  /** Per-loop engine override (provider id); validated against AgentRegistry. */
  engine?: string | null;
  /**
   * Per-loop model override; requires a resolvable engine (loop engine → project
   * defaultEngine → registry default) and must be a model id that engine lists.
   */
  model?: string | null;
}

/**
 * Patch subset for PATCH /loops/:id (v1.1). Omitted fields unchanged. The
 * schedule spec is NOT editable via this route in v1. Rejected on completed
 * loops (their config is history); allowed on active/paused/broken.
 */
export interface UpdateLoopDto {
  name?: string | null;
  goal?: string;
  maxRunsPerDay?: number;
  maxConsecutiveFailures?: number;
  stop?: StopCondition;
  engine?: string | null;
  model?: string | null;
}

export interface LoopRunDto {
  id: string;
  loopId: string;
  taskId: string | null;
  outcome: LoopRunOutcome;
  verify: LoopRunVerify;
  dayBucket: string;
  createdAt: number;
}

export interface LoopRow {
  id: string;
  name: string | null;
  goal: string;
  schedule_id: string;
  max_runs_per_day: number;
  max_consecutive_failures: number;
  stop_json: string | null;
  escalation: string;
  project_path: string | null;
  engine: string | null;
  model: string | null;
  status: string;
  created_at: number;
  updated_at: number;
}

export interface LoopRunRow {
  id: string;
  loop_id: string;
  task_id: string | null;
  outcome: string;
  verify: string;
  day_bucket: string;
  created_at: number;
}

export const DEFAULT_MAX_RUNS_PER_DAY = 24;
export const DEFAULT_MAX_CONSECUTIVE_FAILURES = 3;

/**
 * A signal the loop primitive asks the attention queue to raise. Kept local
 * (structurally identical to the attention module's RaiseSignal) so the loops
 * module never imports the attention module — the heartbeat, which already has
 * both, binds the {@link LoopDto} service's attention seam. Avoids a DI cycle
 * (AttentionModule already imports LoopsModule).
 */
export interface LoopAttentionSignal {
  kind: string;
  subjectId: string;
  projectPath?: string | null;
  title: string;
  payload?: Record<string, unknown> | null;
}

/**
 * Default wedged-run safety-net threshold. A loop run born `pending` whose task
 * is still RUNNING this long has almost certainly wedged (a silent session that
 * never settles) — long enough that a legitimately long agent run rarely trips
 * it, short enough to recover within a work session. Founder-tunable via
 * NUNCIO_LOOP_STUCK_PENDING_AGE_MIN.
 */
export const DEFAULT_STUCK_PENDING_AGE_MS = 180 * 60 * 1000;
