import { describe, expect, test } from 'bun:test';
import {
  compareCoverageToBaseline,
  lineCoverageFromLcov,
  lineCoverageFromVitestSummary,
} from './coverage-ratchet-utils.mjs';

describe('lineCoverageFromLcov', () => {
  test('sums LH/LF across all SF records', () => {
    const lcov = [
      'SF:src/a.ts',
      'DA:1,1',
      'LF:10',
      'LH:8',
      'end_of_record',
      'SF:src/b.ts',
      'LF:10',
      'LH:6',
      'end_of_record',
    ].join('\n');
    expect(lineCoverageFromLcov(lcov)).toBeCloseTo(70, 5);
  });

  test('falls back to DA lines when LF/LH are absent', () => {
    const lcov = ['SF:src/a.ts', 'DA:1,1', 'DA:2,0', 'DA:3,4', 'end_of_record'].join('\n');
    expect(lineCoverageFromLcov(lcov)).toBeCloseTo((2 / 3) * 100, 5);
  });

  test('throws on lcov with no line data (never silently reports 0 or 100)', () => {
    expect(() => lineCoverageFromLcov('')).toThrow(/no line coverage data/i);
  });
});

describe('lineCoverageFromVitestSummary', () => {
  test('reads total.lines.pct', () => {
    expect(lineCoverageFromVitestSummary({ total: { lines: { pct: 43.21 } } })).toBe(43.21);
  });

  test('throws when the summary shape is unexpected', () => {
    expect(() => lineCoverageFromVitestSummary({ total: {} })).toThrow(/total\.lines\.pct/);
  });
});

describe('compareCoverageToBaseline', () => {
  const baseline = { tolerancePct: 0.25, targets: { server: 61.3, web: 40.0 } };

  test('passes when every target is at or above baseline minus tolerance', () => {
    const result = compareCoverageToBaseline({ server: 61.1, web: 45.2 }, baseline);
    expect(result.failures).toEqual([]);
    expect(result.improved).toEqual(['web']);
  });

  test('fails a target that dropped below baseline minus tolerance', () => {
    const result = compareCoverageToBaseline({ server: 60.9, web: 40.0 }, baseline);
    expect(result.failures).toEqual([
      { target: 'server', current: 60.9, baseline: 61.3, floor: 61.05 },
    ]);
  });

  test('fails when a baseline target has no current measurement', () => {
    const result = compareCoverageToBaseline({ server: 61.3 }, baseline);
    expect(result.failures).toEqual([
      { target: 'web', current: null, baseline: 40.0, floor: 39.75 },
    ]);
  });

  test('flags improvement only when above baseline by more than tolerance', () => {
    const result = compareCoverageToBaseline({ server: 61.4, web: 41.5 }, baseline);
    expect(result.improved).toEqual(['web']);
  });
});
