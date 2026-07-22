import { BadRequestException } from '@nestjs/common';
import type { ParsedSpec } from './scheduler.types';

/**
 * v1 cron subset parser + next-fire computer. Timezone-naive (local frame),
 * founder-locked to no dependency. Supported specs:
 *   daily@HH:MM · every:<N>m|<N>h · <weekday>@HH:MM (mon..sun)
 */

const WEEKDAYS: Record<string, number> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

function reject(spec: string, why: string): never {
  throw new BadRequestException(`invalid schedule spec "${spec}": ${why}`);
}

/** Parse and validate HH:MM; throws with a time/hour/minute-specific reason. */
function parseHhMm(spec: string, hhmm: string): { hour: number; minute: number } {
  const match = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!match) reject(spec, `bad time "${hhmm}" (want HH:MM)`);
  const hour = Number(match![1]);
  const minute = Number(match![2]);
  if (hour > 23) reject(spec, `hour out of range in "${hhmm}"`);
  if (minute > 59) reject(spec, `minute out of range in "${hhmm}"`);
  return { hour, minute };
}

export function parseScheduleSpec(spec: string): ParsedSpec {
  const trimmed = (spec ?? '').trim();
  if (trimmed.length === 0) reject(spec, 'empty');

  if (trimmed.startsWith('daily@')) {
    const { hour, minute } = parseHhMm(spec, trimmed.slice('daily@'.length));
    return { type: 'daily', hour, minute };
  }

  if (trimmed.startsWith('every:')) {
    const body = trimmed.slice('every:'.length);
    const match = /^(\d+)([mh])$/.exec(body);
    if (!match) reject(spec, `bad interval "${body}" (want <N>m or <N>h)`);
    const n = Number(match![1]);
    if (!Number.isInteger(n) || n <= 0) {
      reject(spec, `interval must be a positive integer in "${body}"`);
    }
    return { type: 'interval', ms: n * (match![2] === 'h' ? HOUR_MS : MINUTE_MS) };
  }

  const weekdayMatch = /^([a-z]{3})@(.+)$/.exec(trimmed);
  if (weekdayMatch && weekdayMatch[1]! in WEEKDAYS) {
    const weekday = WEEKDAYS[weekdayMatch[1]!]!;
    const { hour, minute } = parseHhMm(spec, weekdayMatch[2]!);
    return { type: 'weekday', weekday, hour, minute };
  }
  if (weekdayMatch) reject(spec, `unknown weekday "${weekdayMatch[1]}"`);

  reject(spec, 'unrecognized (v1 supports daily@HH:MM, every:<N>m|h, <weekday>@HH:MM)');
}

/** Validate a clock cadence without leaking parser exceptions into application startup. */
export function isValidScheduleSpec(spec: string): boolean {
  try {
    parseScheduleSpec(spec);
    return true;
  } catch {
    return false;
  }
}

/** Next fire strictly after `now` (epoch ms) for a parsed spec, in local time. */
export function nextFireAfter(spec: ParsedSpec, now: number): number {
  if (spec.type === 'interval') {
    return now + spec.ms;
  }

  // daily / weekday: build today's HH:MM occurrence in the local frame, then walk
  // forward day-by-day until strictly after now (and, for weekday, on the target
  // weekday). Date(y,mo,d,...) construction is DST/month-end/leap-year correct.
  const base = new Date(now);
  const candidate = new Date(
    base.getFullYear(),
    base.getMonth(),
    base.getDate(),
    spec.hour,
    spec.minute,
    0,
    0,
  );

  if (spec.type === 'daily') {
    if (candidate.getTime() <= now) candidate.setDate(candidate.getDate() + 1);
    return candidate.getTime();
  }

  // weekday: walk forward to the target weekday, strictly after now.
  for (let i = 0; i < 8; i += 1) {
    if (candidate.getDay() === spec.weekday && candidate.getTime() > now) {
      return candidate.getTime();
    }
    candidate.setDate(candidate.getDate() + 1);
  }
  return candidate.getTime();
}
