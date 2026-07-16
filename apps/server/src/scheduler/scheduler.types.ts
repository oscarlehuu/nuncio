import type { CreateTaskDto } from '../tasks/tasks.types';

export type ScheduleKind = 'cron' | 'event' | 'heartbeat';

/** Terminal marker recorded on each fire. */
export type FireResult = 'ok' | 'skipped-overlap' | 'missed' | `error:${string}`;

/**
 * A schedule's target — what a fire does. v1 = enqueue a task from a template.
 * A `{ kind: 'loop', loopId }` variant rides the same column when sub-phase C
 * lands; the firing path branches on `kind`, both flow through TasksService.
 */
export type ScheduleTarget =
  | { kind: 'task'; template: Partial<CreateTaskDto> & { prompt: string } }
  | { kind: 'loop'; loopId: string }
  // A rung-3 heartbeat layer — an internal system job, resolved through the
  // registered system-fire handler (like `loop` via setLoopFireHandler). These
  // are NOT exposed in the loops UI, so they are not deletable/breakable there.
  | { kind: 'system'; job: string };

/** Parsed cron/heartbeat spec (v1 subset — no full crontab). */
export type ParsedSpec =
  | { type: 'daily'; hour: number; minute: number }
  | { type: 'interval'; ms: number }
  | { type: 'weekday'; weekday: number; hour: number; minute: number }; // 0=Sun..6=Sat

/** Filter for an event-kind schedule, matched against a normalized webhook event. */
export interface EventFilter {
  /** '<kind>.<action>', e.g. 'issue.opened'. */
  event: string;
  /** Optional label that must be present on the event. */
  label?: string;
}

export interface ScheduleDto {
  id: string;
  kind: ScheduleKind;
  spec: string;
  target: ScheduleTarget;
  enabled: boolean;
  nextFireAt: number | null;
  lastFireAt: number | null;
  lastResult: FireResult | null;
  createdAt: number;
  updatedAt: number;
}

export interface CreateScheduleDto {
  kind: ScheduleKind;
  spec: string;
  target: ScheduleTarget;
  enabled?: boolean;
}

export interface ScheduleRow {
  id: string;
  kind: string;
  spec: string;
  target_json: string;
  enabled: number;
  next_fire_at: number | null;
  last_fire_at: number | null;
  last_result: string | null;
  created_at: number;
  updated_at: number;
}

/**
 * A schedule whose stored next-fire was so stale on boot (older than the
 * missed-fire window, i.e. the machine was offline > 24h) that rehydrate skipped
 * it forward instead of firing it. Buffered so an observer (the heartbeat) can
 * surface it — otherwise the skipped fires would advance silently.
 */
export interface StaleScheduleSkip {
  scheduleId: string;
  kind: ScheduleKind;
  spec: string;
  target: ScheduleTarget;
  /** The overdue next-fire that was skipped (epoch ms). */
  previousFireAt: number;
  /** The recomputed future next-fire (epoch ms), or null for an unparseable spec. */
  recomputedFireAt: number | null;
}

/** Injectable clock seam — deterministic in tests, Date.now() in production. */
export interface Clock {
  now(): number;
}
