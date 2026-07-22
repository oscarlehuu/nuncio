import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { computeStreamMetrics } from '../../../src/observability/stream-metrics';
import type {
  StreamEventInput,
  StreamEventType,
  StreamMetricsReport,
  StreamStall,
} from '../../../src/observability/stream-metrics';

const FIXTURE_DIR = join(__dirname, 'fixtures');

const DELTA: StreamEventType = 'delta';

function delta(ts: number, tokens?: number): StreamEventInput {
  return tokens === undefined ? { ts, type: DELTA } : { ts, type: DELTA, tokens };
}

describe('computeStreamMetrics', () => {
  it('matches the sample fixture report exactly', () => {
    const lines = readFileSync(join(FIXTURE_DIR, 'sample-events.jsonl'), 'utf8')
      .split('\n')
      .filter((line) => line.trim().length > 0);
    const events = lines.map((line) => JSON.parse(line));
    const expected = JSON.parse(
      readFileSync(join(FIXTURE_DIR, 'sample-expected.json'), 'utf8'),
    ) as StreamMetricsReport;

    expect(computeStreamMetrics(events)).toEqual(expected);
  });

  it('returns an empty report when there are no valid events', () => {
    expect(computeStreamMetrics([])).toEqual({
      turns: 0,
      ttftMs: { perTurn: [], median: null },
      interDeltaGapMs: { p50: null, p95: null, max: null },
      tokensPerSecond: null,
      stalls: [],
      totalDeltaTokens: 0,
    });
  });

  it('sanitizes non-object, non-finite ts, and unknown type rows', () => {
    const report = computeStreamMetrics([
      null,
      42,
      'nope',
      { ts: Number.NaN, type: 'delta', tokens: 5 },
      { ts: Infinity, type: 'delta', tokens: 5 },
      { ts: 'bad', type: 'turn_start' },
      { ts: 100, type: 'mystery' },
      { ts: 1000, type: 'turn_start' },
      { ts: 1200, type: 'delta', tokens: 7 },
    ]);
    expect(report.turns).toBe(1);
    expect(report.totalDeltaTokens).toBe(7);
    expect(report.ttftMs.perTurn).toEqual([200]);
  });

  it('stable-sorts out-of-order timestamps before assigning turns', () => {
    const report = computeStreamMetrics([
      delta(6000, 3),
      { ts: 5000, type: 'turn_start' },
      delta(5600, 2),
      { ts: 9000, type: 'turn_end' },
      delta(8600, 4),
    ]);
    expect(report.turns).toBe(1);
    expect(report.ttftMs.perTurn).toEqual([600]);
    expect(report.totalDeltaTokens).toBe(9);
    // within-turn gaps: 5600->6000 = 400, 6000->8600 = 2600
    expect(report.interDeltaGapMs.max).toBe(2600);
  });

  it('defaults a delta without a numeric tokens field to 1', () => {
    const report = computeStreamMetrics([
      { ts: 1000, type: 'turn_start' },
      { ts: 1100, type: 'delta' },
      { ts: 1200, type: 'delta', tokens: undefined },
      { ts: 1300, type: 'delta', tokens: 4 },
    ]);
    expect(report.totalDeltaTokens).toBe(6);
  });

  it('ignores deltas outside an open turn', () => {
    const report = computeStreamMetrics([
      delta(500, 99), // before first turn_start
      { ts: 1000, type: 'turn_start' },
      delta(1400, 5),
      { ts: 1900, type: 'turn_end' },
      delta(1950, 50), // between turn_end and next turn_start
      { ts: 3000, type: 'turn_start' },
      delta(3200, 3),
    ]);
    expect(report.turns).toBe(2);
    expect(report.totalDeltaTokens).toBe(8);
    expect(report.ttftMs.perTurn).toEqual([400, 200]);
  });

  it('reports a zero-delta turn as null ttft and counts it as a turn', () => {
    const report = computeStreamMetrics([
      { ts: 1000, type: 'turn_start' },
      { ts: 1500, type: 'turn_end' },
    ]);
    expect(report.turns).toBe(1);
    expect(report.ttftMs.perTurn).toEqual([null]);
    expect(report.ttftMs.median).toBeNull();
    expect(report.tokensPerSecond).toBeNull();
  });

  it('counts an unclosed trailing turn', () => {
    const report = computeStreamMetrics([
      { ts: 1000, type: 'turn_start' },
      delta(1200, 2),
      { ts: 2000, type: 'turn_end' },
      { ts: 3000, type: 'turn_start' },
      delta(3300, 4),
    ]);
    expect(report.turns).toBe(2);
    expect(report.ttftMs.perTurn).toEqual([200, 300]);
  });

  it('honors a custom stallThresholdMs', () => {
    const events = [
      { ts: 1000, type: 'turn_start' as const },
      delta(1100, 1),
      delta(1400, 1), // gap 300
      delta(2000, 1), // gap 600
    ];
    expect(computeStreamMetrics(events).stalls).toEqual([]);
    const expectedStalls: StreamStall[] = [{ turnIndex: 0, startTs: 1400, gapMs: 600 }];
    expect(computeStreamMetrics(events, { stallThresholdMs: 500 }).stalls).toEqual(expectedStalls);
  });

  it('returns null tokensPerSecond when fewer than 2 counted deltas', () => {
    const report = computeStreamMetrics([
      { ts: 1000, type: 'turn_start' },
      delta(1200, 5),
    ]);
    expect(report.tokensPerSecond).toBeNull();
    expect(report.interDeltaGapMs).toEqual({ p50: null, p95: null, max: null });
  });
});
