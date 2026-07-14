import { describe, expect, it } from 'vitest';
import { buildHeatmapWeeks, heatmapLevel } from './usage-heatmap-utils';
import type { UsageHistoryDayDto } from '@/lib/usage-api';

function day(date: string, claude = 100): UsageHistoryDayDto {
  return { date, claude, codex: 0, cursor: 0 };
}

describe('usage-heatmap-utils', () => {
  describe('buildHeatmapWeeks', () => {
    it('returns empty for no days', () => {
      expect(buildHeatmapWeeks([])).toEqual([]);
    });

    it('pads incomplete weeks Monday-first', () => {
      // 2026-07-14 is a Tuesday
      const weeks = buildHeatmapWeeks([day('2026-07-14', 10)]);
      expect(weeks).toHaveLength(1);
      expect(weeks[0]).toHaveLength(7);
      expect(weeks[0]![0]).toBeNull(); // Mon pad
      expect(weeks[0]![1]).toEqual(day('2026-07-14', 10)); // Tue
      expect(weeks[0]!.slice(2).every((cell) => cell === null)).toBe(true);
    });

    it('spans multiple weeks oldest → newest', () => {
      const weeks = buildHeatmapWeeks([
        day('2026-07-13'), // Mon
        day('2026-07-20'), // next Mon
      ]);
      expect(weeks.length).toBeGreaterThanOrEqual(2);
      expect(weeks[0]![0]).toEqual(day('2026-07-13'));
      expect(weeks[1]![0]).toEqual(day('2026-07-20'));
    });
  });

  describe('heatmapLevel', () => {
    it('returns 0 for empty or zero max', () => {
      expect(heatmapLevel(0, 100)).toBe(0);
      expect(heatmapLevel(10, 0)).toBe(0);
      expect(heatmapLevel(-1, 100)).toBe(0);
    });

    it('buckets by ratio thresholds', () => {
      expect(heatmapLevel(1, 100)).toBe(1); // < 0.15
      expect(heatmapLevel(14, 100)).toBe(1);
      expect(heatmapLevel(15, 100)).toBe(2); // < 0.35
      expect(heatmapLevel(34, 100)).toBe(2);
      expect(heatmapLevel(35, 100)).toBe(3); // < 0.65
      expect(heatmapLevel(64, 100)).toBe(3);
      expect(heatmapLevel(65, 100)).toBe(4);
      expect(heatmapLevel(100, 100)).toBe(4);
    });
  });
});
