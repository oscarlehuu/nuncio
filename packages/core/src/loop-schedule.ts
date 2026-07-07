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

export function formatScheduleSpec(spec: string): string {
  const trimmed = (spec ?? '').trim();
  if (!trimmed) return 'No schedule';

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
  mode: 'daily' | 'interval' | 'weekday',
  fields: { time?: string; interval?: number; unit?: 'm' | 'h'; weekday?: string },
): string {
  if (mode === 'interval') return `every:${fields.interval ?? 1}${fields.unit ?? 'h'}`;
  if (mode === 'weekday') return `${fields.weekday ?? 'mon'}@${fields.time ?? '22:00'}`;
  return `daily@${fields.time ?? '22:00'}`;
}

/** Runs whose day bucket is today's local YYYY-MM-DD — the day-budget numerator. */
export function runsToday(runs: LoopRunDto[], now = Date.now()): number {
  const today = localDayBucket(now);
  return runs.filter((r) => r.dayBucket === today && r.outcome !== 'resume').length;
}

/** Local YYYY-MM-DD, matching the server's timezone-naive day bucket. */
export function localDayBucket(now = Date.now()): string {
  const d = new Date(now);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** The most recent run that actually executed (has a real outcome, not a resume marker). */
export function lastExecutedRun(runs: LoopRunDto[]): LoopRunDto | null {
  for (let i = runs.length - 1; i >= 0; i -= 1) {
    const run = runs[i];
    if (run && run.outcome !== 'resume') return run;
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
