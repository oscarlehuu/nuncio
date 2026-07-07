export type LoopStatus = 'active' | 'paused' | 'broken' | 'completed';

export type LoopRunOutcome = 'ok' | 'failed' | 'budget-exhausted' | 'resume';

/** Stop condition v1: null = standing (run until paused) | max total runs. */
export type StopCondition = null | { kind: 'maxTotalRuns'; n: number };

export interface LoopDto {
  id: string;
  /** (1) goal — the prompt each run enqueues. */
  goal: string;
  /** (2) trigger — the loop OWNS this schedules row. */
  scheduleId: string;
  /** (3) budget. */
  maxRunsPerDay: number;
  maxConsecutiveFailures: number;
  /** (4) stop condition. */
  stop: StopCondition;
  /** (5) escalation policy (v1: 'needs-attention'). */
  escalation: string;
  projectPath: string | null;
  status: LoopStatus;
  createdAt: number;
  updatedAt: number;
}

export interface CreateLoopDto {
  goal: string;
  /** Trigger spec — the loop creates + owns a schedule from this. */
  schedule: { kind: 'cron' | 'heartbeat' | 'event'; spec: string };
  maxRunsPerDay?: number;
  maxConsecutiveFailures?: number;
  stop?: StopCondition;
  projectPath?: string;
}

export interface LoopRunDto {
  id: string;
  loopId: string;
  taskId: string | null;
  outcome: LoopRunOutcome;
  dayBucket: string;
  createdAt: number;
}

export interface LoopRow {
  id: string;
  goal: string;
  schedule_id: string;
  max_runs_per_day: number;
  max_consecutive_failures: number;
  stop_json: string | null;
  escalation: string;
  project_path: string | null;
  status: string;
  created_at: number;
  updated_at: number;
}

export interface LoopRunRow {
  id: string;
  loop_id: string;
  task_id: string | null;
  outcome: string;
  day_bucket: string;
  created_at: number;
}

export const DEFAULT_MAX_RUNS_PER_DAY = 24;
export const DEFAULT_MAX_CONSECUTIVE_FAILURES = 3;
