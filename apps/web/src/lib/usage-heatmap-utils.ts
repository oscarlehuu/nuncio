/** Pure helpers for the usage activity heatmap (kept separate for Fast Refresh). */

import type { UsageHistoryDayDto } from '@/lib/usage-api';

export type HeatmapCell = UsageHistoryDayDto | null;

/** Monday-first weeks, oldest → newest. Null pads incomplete edges. */
export function buildHeatmapWeeks(days: ReadonlyArray<UsageHistoryDayDto>): HeatmapCell[][] {
  if (days.length === 0) return [];
  const byDate = new Map(days.map((day) => [day.date, day]));
  const first = days[0]!;
  const last = days[days.length - 1]!;
  const start = new Date(`${first.date}T12:00:00`);
  const end = new Date(`${last.date}T12:00:00`);

  const startDow = (start.getDay() + 6) % 7; // Mon=0
  start.setDate(start.getDate() - startDow);

  const endDow = (end.getDay() + 6) % 7;
  end.setDate(end.getDate() + (6 - endDow));

  const weeks: HeatmapCell[][] = [];
  const cursor = new Date(start);
  while (cursor <= end) {
    const week: HeatmapCell[] = [];
    for (let i = 0; i < 7; i += 1) {
      const y = cursor.getFullYear();
      const m = String(cursor.getMonth() + 1).padStart(2, '0');
      const d = String(cursor.getDate()).padStart(2, '0');
      const key = `${y}-${m}-${d}`;
      week.push(byDate.get(key) ?? null);
      cursor.setDate(cursor.getDate() + 1);
    }
    weeks.push(week);
  }
  return weeks;
}

/** 0 empty → 4 hottest. */
export function heatmapLevel(value: number, max: number): 0 | 1 | 2 | 3 | 4 {
  if (value <= 0 || max <= 0) return 0;
  const ratio = value / max;
  if (ratio < 0.15) return 1;
  if (ratio < 0.35) return 2;
  if (ratio < 0.65) return 3;
  return 4;
}
