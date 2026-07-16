import type { LoopRunDto, LoopRunVerify } from './api';

/**
 * Human-readable rendering of the v1 schedule spec subset the server parses
 * (`daily@HH:MM` · `every:<N>m|h` · `<weekday>@HH:MM`, mon..sun). Pure mirror of
 * apps/server schedule-spec.ts — kept here so the create-form preview and any row
 * label read the same. Returns the raw spec unchanged if it does not parse, so a
 * future spec form never renders a lie.
 */

const WEEKDAY_LABELS: Record<string, string> = {
  sun: 'Sunday',
  mon: 'Monday',
  tue: 'Tuesday',
  wed: 'Wednesday',
  thu: 'Thursday',
  fri: 'Friday',
  sat: 'Saturday',
};

/** The schedule families the create/edit form offers. */
export type ScheduleFormMode = 'daily' | 'interval' | 'weekday' | 'event';

/**
 * The event trigger catalog — grounded in what the forge webhook layer ACTUALLY
 * delivers: `<kind>.<action>` where kind ∈ {issue, pull_request} and action is the
 * common vocabulary both GitHub and GitLab emit (GitLab normalizes open/reopen/
 * close/merge → opened/reopened/closed/merged). No invented events; a filter here
 * matches the server's `${event.kind}.${event.action}` comparison exactly.
 */
export const EVENT_CATALOG: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'issue.opened', label: 'Issue opened' },
  { value: 'issue.closed', label: 'Issue closed' },
  { value: 'issue.reopened', label: 'Issue reopened' },
  { value: 'pull_request.opened', label: 'Pull request opened' },
  { value: 'pull_request.closed', label: 'Pull request closed' },
  { value: 'pull_request.reopened', label: 'Pull request reopened' },
  { value: 'pull_request.merged', label: 'Pull request merged' },
];

/** Default event when a form switches to the event trigger family. */
export const DEFAULT_EVENT = 'issue.opened';

function eventLabel(value: string): string {
  return EVENT_CATALOG.find((e) => e.value === value)?.label ?? value;
}

/** Parse an event-filter spec (`{event, label?}` JSON), or null if it is not one. */
function parseEventFilter(spec: string): { event: string; label?: string } | null {
  const trimmed = spec.trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(trimmed) as { event?: unknown; label?: unknown };
    if (typeof parsed.event !== 'string' || !parsed.event) return null;
    return {
      event: parsed.event,
      label: typeof parsed.label === 'string' && parsed.label ? parsed.label : undefined,
    };
  } catch {
    return null;
  }
}

export function formatScheduleSpec(spec: string): string {
  const trimmed = (spec ?? '').trim();
  if (!trimmed) return 'No schedule';

  const filter = parseEventFilter(trimmed);
  if (filter) {
    const base = `On ${eventLabel(filter.event)}`;
    return filter.label ? `${base} · label “${filter.label}”` : base;
  }

  if (trimmed.startsWith('daily@')) {
    const time = trimmed.slice('daily@'.length);
    return isHhMm(time) ? `Daily at ${time}` : trimmed;
  }

  if (trimmed.startsWith('every:')) {
    const body = trimmed.slice('every:'.length);
    const match = /^(\d+)([mh])$/.exec(body);
    if (!match) return trimmed;
    const n = Number(match[1]);
    const unit = match[2] === 'h' ? 'hour' : 'minute';
    return `Every ${n} ${unit}${n === 1 ? '' : 's'}`;
  }

  const weekday = /^([a-z]{3})@(.+)$/.exec(trimmed);
  if (weekday && WEEKDAY_LABELS[weekday[1]!] && isHhMm(weekday[2]!)) {
    return `${WEEKDAY_LABELS[weekday[1]!]} at ${weekday[2]}`;
  }

  return trimmed;
}

function isHhMm(value: string): boolean {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (!match) return false;
  return Number(match[1]) <= 23 && Number(match[2]) <= 59;
}

/** Build a valid spec string from the create-form fields — the inverse of the parser. */
export function buildScheduleSpec(
  mode: ScheduleFormMode,
  fields: { time?: string; interval?: number; unit?: 'm' | 'h'; weekday?: string; event?: string; label?: string },
): string {
  if (mode === 'event') {
    const event = fields.event ?? DEFAULT_EVENT;
    const label = fields.label?.trim();
    // Serialize with `event` first for a stable, human-diffable filter string.
    return JSON.stringify(label ? { event, label } : { event });
  }
  if (mode === 'interval') return `every:${fields.interval ?? 1}${fields.unit ?? 'h'}`;
  if (mode === 'weekday') return `${fields.weekday ?? 'mon'}@${fields.time ?? '22:00'}`;
  return `daily@${fields.time ?? '22:00'}`;
}

/** All schedule-form fields, fully populated with sane defaults. */
export interface ScheduleFormFields {
  mode: ScheduleFormMode;
  time: string;
  interval: number;
  unit: 'm' | 'h';
  weekday: string;
  event: string;
  label: string;
}

const DEFAULT_SCHEDULE_FIELDS: ScheduleFormFields = {
  mode: 'daily',
  time: '22:00',
  interval: 6,
  unit: 'h',
  weekday: 'mon',
  event: DEFAULT_EVENT,
  label: '',
};

/**
 * Seed the edit form from a stored `{kind, spec}` — the inverse of
 * {@link buildScheduleSpec}. Every field is populated (defaults for the ones the
 * parsed family doesn't use) so the form never binds an undefined input. An
 * unrecognized spec falls back to the daily default rather than throwing, so a
 * legacy/hand-written spec still opens an editable form.
 */
export function parseSpecToFields(kind: string, spec: string): ScheduleFormFields {
  const trimmed = (spec ?? '').trim();

  const filter = parseEventFilter(trimmed);
  if (kind === 'event' || filter) {
    return {
      ...DEFAULT_SCHEDULE_FIELDS,
      mode: 'event',
      event: filter?.event ?? DEFAULT_EVENT,
      label: filter?.label ?? '',
    };
  }

  if (trimmed.startsWith('daily@')) {
    const time = trimmed.slice('daily@'.length);
    if (isHhMm(time)) return { ...DEFAULT_SCHEDULE_FIELDS, mode: 'daily', time };
  }

  if (trimmed.startsWith('every:')) {
    const match = /^(\d+)([mh])$/.exec(trimmed.slice('every:'.length));
    if (match) {
      return {
        ...DEFAULT_SCHEDULE_FIELDS,
        mode: 'interval',
        interval: Number(match[1]),
        unit: match[2] === 'h' ? 'h' : 'm',
      };
    }
  }

  const weekday = /^([a-z]{3})@(.+)$/.exec(trimmed);
  if (weekday && WEEKDAY_LABELS[weekday[1]!] && isHhMm(weekday[2]!)) {
    return { ...DEFAULT_SCHEDULE_FIELDS, mode: 'weekday', weekday: weekday[1]!, time: weekday[2]! };
  }

  return { ...DEFAULT_SCHEDULE_FIELDS };
}

/**
 * Runs that CONSUMED a day's budget slot, bucketed to today's local YYYY-MM-DD.
 * Mirrors the server: only an enqueued run counts (`pending` in-flight, or its
 * settled `ok`/`failed`). Bookkeeping rows — `resume`, `budget-exhausted`, and any
 * future marker — are transparent, so the count never inflates past the budget.
 */
const CONSUMED_OUTCOMES: ReadonlySet<LoopRunDto['outcome']> = new Set(['pending', 'ok', 'failed']);

export function runsToday(runs: LoopRunDto[], now = Date.now()): number {
  const today = localDayBucket(now);
  return runs.filter((r) => r.dayBucket === today && CONSUMED_OUTCOMES.has(r.outcome)).length;
}

/** Local YYYY-MM-DD, matching the server's timezone-naive day bucket. */
export function localDayBucket(now = Date.now()): string {
  const d = new Date(now);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * The most recent run that actually SETTLED (`ok`/`failed`) — the row's "Last run …
 * Verify passed/failed" line needs a settled verify signal, so an in-flight
 * `pending` run and bookkeeping markers (`resume`, `budget-exhausted`) are skipped.
 */
export function lastExecutedRun(runs: LoopRunDto[]): LoopRunDto | null {
  for (let i = runs.length - 1; i >= 0; i -= 1) {
    const run = runs[i];
    if (run && (run.outcome === 'ok' || run.outcome === 'failed')) return run;
  }
  return null;
}

/** Trailing consecutive `failed` runs since the last ok/resume — the breaker numerator. */
export function failureStreak(runs: LoopRunDto[]): number {
  let streak = 0;
  for (let i = runs.length - 1; i >= 0; i -= 1) {
    const run = runs[i];
    if (!run) continue;
    if (run.outcome === 'failed') streak += 1;
    else if (run.outcome === 'ok' || run.outcome === 'resume') break;
  }
  return streak;
}

export function verifyLabel(verify: LoopRunVerify): string {
  if (verify === 'green') return 'Verify passed';
  if (verify === 'red') return 'Verify failed';
  return 'No verify';
}

/**
 * Display label for a loop: the explicit `name` when set, else a trimmed excerpt of
 * the goal (loops are keyed by goal but a long prompt makes a poor row title).
 */
export function loopDisplayName(loop: { name?: string | null; goal: string }, max = 80): string {
  const name = loop.name?.trim();
  if (name) return name;
  const goal = loop.goal.trim();
  return goal.length > max ? `${goal.slice(0, max - 1).trimEnd()}…` : goal;
}

/**
 * Forward-looking "next fire" label for a loop's `nextFireAt` (epoch ms). Returns
 * null when there is no scheduled fire (event/none trigger, or a missing schedule)
 * so the row can render nothing rather than a fabricated time. A fire already due
 * reads "due now" (the scheduler runs it on the next tick).
 */
export function formatNextFire(nextFireAt: number | null | undefined, now = Date.now()): string | null {
  if (nextFireAt == null) return null;
  const diff = nextFireAt - now;
  if (diff <= 0) return 'Next run due now';
  if (diff < 60_000) return 'Next run in under a minute';
  if (diff < 3_600_000) return `Next run in ${Math.round(diff / 60_000)}m`;
  if (diff < 86_400_000) return `Next run in ${Math.round(diff / 3_600_000)}h`;
  return `Next run in ${Math.round(diff / 86_400_000)}d`;
}
