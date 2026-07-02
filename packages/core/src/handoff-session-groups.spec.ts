import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  formatHandoffDayLabel,
  formatHandoffSessionTime,
  groupHandoffSessionsByDay,
  localDayKey,
} from './handoff-session-groups';

function session(updatedAt: number, id: string) {
  return {
    id,
    updatedAt,
  };
}

describe('handoff-session-groups', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('groups sessions by local calendar day, newest day first', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-28T12:00:00'));

    const todayMorning = new Date('2026-06-28T09:00:00').getTime();
    const todayAfternoon = new Date('2026-06-28T15:00:00').getTime();
    const yesterday = new Date('2026-06-27T20:00:00').getTime();

    const groups = groupHandoffSessionsByDay([
      session(yesterday, 'old'),
      session(todayAfternoon, 'later'),
      session(todayMorning, 'earlier'),
    ]);

    expect(groups).toHaveLength(2);
    expect(groups[0]?.label).toBe('Today');
    expect(groups[0]?.items.map((item) => item.id)).toEqual(['later', 'earlier']);
    expect(groups[1]?.label).toBe('Yesterday');
    expect(groups[1]?.items.map((item) => item.id)).toEqual(['old']);
  });

  it('labels today and yesterday relative to now', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-28T12:00:00'));

    const todayKey = localDayKey(new Date('2026-06-28T08:00:00').getTime());
    const yesterdayKey = localDayKey(new Date('2026-06-27T08:00:00').getTime());
    const olderKey = localDayKey(new Date('2026-06-20T08:00:00').getTime());

    expect(formatHandoffDayLabel(todayKey)).toBe('Today');
    expect(formatHandoffDayLabel(yesterdayKey)).toBe('Yesterday');
    expect(formatHandoffDayLabel(olderKey)).toMatch(/Jun 20, 2026/);
  });

  it('formats session time as local clock time', () => {
    const ms = new Date('2026-06-28T21:30:00').getTime();
    expect(formatHandoffSessionTime(ms)).toMatch(/9:30/);
  });
});
