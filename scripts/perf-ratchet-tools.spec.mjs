import { describe, expect, test } from 'bun:test';
import {
  ceilingFor,
  compareMetricsToBaseline,
  floorFor,
  median,
  summarize,
} from './perf-ratchet-utils.mjs';

describe('median', () => {
  test('single sample is itself', () => {
    expect(median([42])).toBe(42);
  });

  test('odd count picks the middle after sorting', () => {
    expect(median([9, 1, 5])).toBe(5);
  });

  test('even count averages the two middle values', () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([4, 1])).toBe(2.5);
  });

  test('throws on empty input — a zero-sample metric is a harness bug, never a silent 0', () => {
    expect(() => median([])).toThrow(/at least one sample/i);
  });
});

describe('summarize', () => {
  test('reports median, min, max, and coefficient of variation', () => {
    const s = summarize([10, 12, 14]);
    expect(s.median).toBe(12);
    expect(s.min).toBe(10);
    expect(s.max).toBe(14);
    expect(s.cv).toBeGreaterThan(0);
    expect(s.samples).toEqual([10, 12, 14]);
  });

  test('cv is 0 for a near-zero-mean metric (no divide-by-zero blowup)', () => {
    expect(summarize([0, 0, 0]).cv).toBe(0);
  });
});

describe('ceilingFor / floorFor', () => {
  test('multiplicative band away from zero', () => {
    expect(ceilingFor(100, 0.3)).toBe(130);
    expect(floorFor(100, 0.3)).toBe(70);
  });

  test('additive band for a near-zero baseline (no ratio blowup)', () => {
    // baseline 0 with 30% tol → ceiling = 0 + max(1, 0) = 1 ms, floor = 0.
    expect(ceilingFor(0, 0.3)).toBe(1);
    expect(floorFor(0, 0.3)).toBe(0);
  });
});

describe('compareMetricsToBaseline', () => {
  const baseline = {
    tolerancePct: 0.3,
    metrics: {
      ttfdMs: { median: 100, gated: true },
      scrollSweepMs: { median: 200, gated: true },
      streamBlockingMs: { median: 0, gated: false },
    },
  };

  test('passes when a gated metric sits at or under the ceiling', () => {
    const result = compareMetricsToBaseline(
      { ttfdMs: { median: 130 }, scrollSweepMs: { median: 130 }, streamBlockingMs: { median: 999 } },
      baseline,
    );
    expect(result.failures).toEqual([]);
    // ttfd exactly at its 130 ms ceiling passes; scroll (130 < 140 floor) improved.
    expect(result.improved).toEqual(['scrollSweepMs']);
    // Report-only metric never fails even when far above baseline.
    expect(result.reportOnly).toEqual(['streamBlockingMs']);
  });

  test('fails a gated metric one step past the ceiling', () => {
    const result = compareMetricsToBaseline(
      { ttfdMs: { median: 130.01 }, scrollSweepMs: { median: 200 } },
      baseline,
    );
    expect(result.failures).toEqual([
      { metric: 'ttfdMs', current: 130.01, baseline: 100, ceiling: 130 },
    ]);
  });

  test('fails a gated metric that has no current measurement', () => {
    const result = compareMetricsToBaseline({ scrollSweepMs: { median: 200 } }, baseline);
    expect(result.failures).toEqual([
      { metric: 'ttfdMs', current: null, baseline: 100, ceiling: 130 },
    ]);
  });

  test('surfaces a current-only metric as an extra to adopt via --update', () => {
    const result = compareMetricsToBaseline(
      { ttfdMs: { median: 100 }, scrollSweepMs: { median: 200 }, keyEchoMs: { median: 5 } },
      baseline,
    );
    expect(result.extras).toEqual(['keyEchoMs']);
    expect(result.failures).toEqual([]);
  });
});
