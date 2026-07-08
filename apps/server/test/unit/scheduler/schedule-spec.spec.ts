import { describe, expect, it } from 'bun:test';
import { nextFireAfter, parseScheduleSpec } from '../../../src/scheduler/schedule-spec';
import type { ParsedSpec } from '../../../src/scheduler/scheduler.types';

/**
 * Rung 2 sub-phase B — the v1 cron subset parser + next-fire computer. RED until
 * implemented. Timezone-naive: HH:MM is the local frame. Deterministic — no DI,
 * time passed in explicitly.
 */

// A fixed reference instant in local time, built so the tests read clearly.
function at(y: number, mo: number, d: number, h: number, mi: number): number {
  return new Date(y, mo - 1, d, h, mi, 0, 0).getTime();
}

describe('parseScheduleSpec (v1 subset)', () => {
  it('parses daily@HH:MM', () => {
    expect(parseScheduleSpec('daily@09:30')).toEqual({ type: 'daily', hour: 9, minute: 30 });
    expect(parseScheduleSpec('daily@00:00')).toEqual({ type: 'daily', hour: 0, minute: 0 });
    expect(parseScheduleSpec('daily@23:59')).toEqual({ type: 'daily', hour: 23, minute: 59 });
  });

  it('rejects a daily spec with an out-of-range time', () => {
    expect(() => parseScheduleSpec('daily@24:00')).toThrow(/spec|time|hour/i);
    expect(() => parseScheduleSpec('daily@09:60')).toThrow(/spec|time|minute/i);
  });

  it('parses every:<N>m and every:<N>h into an interval', () => {
    expect(parseScheduleSpec('every:15m')).toEqual({ type: 'interval', ms: 15 * 60_000 });
    expect(parseScheduleSpec('every:2h')).toEqual({ type: 'interval', ms: 2 * 3_600_000 });
  });

  it('rejects a non-positive or non-numeric interval', () => {
    expect(() => parseScheduleSpec('every:0m')).toThrow(/spec|interval/i);
    expect(() => parseScheduleSpec('every:-5m')).toThrow(/spec|interval/i);
    expect(() => parseScheduleSpec('every:xm')).toThrow(/spec|interval/i);
  });

  it('parses <weekday>@HH:MM for mon..sun', () => {
    expect(parseScheduleSpec('mon@09:00')).toEqual({ type: 'weekday', weekday: 1, hour: 9, minute: 0 });
    expect(parseScheduleSpec('sun@18:15')).toEqual({ type: 'weekday', weekday: 0, hour: 18, minute: 15 });
  });

  it('rejects an unknown weekday', () => {
    expect(() => parseScheduleSpec('funday@09:00')).toThrow(/spec|weekday/i);
  });

  it('rejects full-crontab / empty / junk specs (v1 subset only)', () => {
    expect(() => parseScheduleSpec('*/5 * * * 1-5')).toThrow(/spec/i);
    expect(() => parseScheduleSpec('')).toThrow(/spec/i);
    expect(() => parseScheduleSpec('nonsense')).toThrow(/spec/i);
  });
});

describe('nextFireAfter', () => {
  const daily = (h: number, mi: number): ParsedSpec => ({ type: 'daily', hour: h, minute: mi });

  it('computes the next daily HH:MM strictly after now (same day)', () => {
    const now = at(2026, 7, 7, 8, 0); // 08:00
    expect(nextFireAfter(daily(9, 30), now)).toBe(at(2026, 7, 7, 9, 30));
  });

  it('rolls to tomorrow when the daily time already passed today', () => {
    const now = at(2026, 7, 7, 10, 0); // 10:00, target 09:30 passed
    expect(nextFireAfter(daily(9, 30), now)).toBe(at(2026, 7, 8, 9, 30));
  });

  it('crosses midnight: 23:59 now, daily@00:30 -> tomorrow 00:30', () => {
    const now = at(2026, 7, 7, 23, 59);
    expect(nextFireAfter(daily(0, 30), now)).toBe(at(2026, 7, 8, 0, 30));
  });

  it('crosses month end: Jan 31 23:00, daily@01:00 -> Feb 1 01:00', () => {
    const now = at(2026, 1, 31, 23, 0);
    expect(nextFireAfter(daily(1, 0), now)).toBe(at(2026, 2, 1, 1, 0));
  });

  it('interval: next fire is now + interval', () => {
    const now = at(2026, 7, 7, 8, 0);
    expect(nextFireAfter({ type: 'interval', ms: 15 * 60_000 }, now)).toBe(at(2026, 7, 7, 8, 15));
  });

  it('weekday: from a Friday, mon@09:00 -> the next Monday 09:00', () => {
    // 2026-07-10 is a Friday.
    const fri = at(2026, 7, 10, 12, 0);
    const expected = at(2026, 7, 13, 9, 0); // Monday
    expect(nextFireAfter({ type: 'weekday', weekday: 1, hour: 9, minute: 0 }, fri)).toBe(expected);
  });
});
