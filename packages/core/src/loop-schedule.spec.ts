import { describe, it, expect } from 'vitest';
import {
  buildScheduleSpec,
  failureStreak,
  formatScheduleSpec,
  lastExecutedRun,
  localDayBucket,
  runsToday,
  verifyLabel,
} from './loop-schedule';
import type { LoopRunDto } from './api';

function run(partial: Partial<LoopRunDto>): LoopRunDto {
  return {
    id: partial.id ?? Math.random().toString(36).slice(2, 8),
    loopId: 'loop-1',
    taskId: partial.taskId ?? 't1',
    outcome: partial.outcome ?? 'ok',
    verify: partial.verify ?? 'none',
    dayBucket: partial.dayBucket ?? localDayBucket(),
    createdAt: partial.createdAt ?? Date.now(),
  };
}

describe('formatScheduleSpec', () => {
  it('renders a daily spec in plain English', () => {
    expect(formatScheduleSpec('daily@22:00')).toBe('Daily at 22:00');
  });
  it('renders an interval spec with a pluralized unit', () => {
    expect(formatScheduleSpec('every:6h')).toBe('Every 6 hours');
    expect(formatScheduleSpec('every:1h')).toBe('Every 1 hour');
    expect(formatScheduleSpec('every:30m')).toBe('Every 30 minutes');
  });
  it('renders a weekday spec with the full day name', () => {
    expect(formatScheduleSpec('mon@09:30')).toBe('Monday at 09:30');
    expect(formatScheduleSpec('fri@18:00')).toBe('Friday at 18:00');
  });
  it('returns the raw spec unchanged when it does not parse', () => {
    expect(formatScheduleSpec('*/5 * * * *')).toBe('*/5 * * * *');
    expect(formatScheduleSpec('daily@99:99')).toBe('daily@99:99');
  });
  it('labels an empty spec', () => {
    expect(formatScheduleSpec('')).toBe('No schedule');
  });
});

describe('buildScheduleSpec round-trips through the formatter', () => {
  it('daily', () => {
    expect(formatScheduleSpec(buildScheduleSpec('daily', { time: '07:15' }))).toBe('Daily at 07:15');
  });
  it('interval', () => {
    expect(buildScheduleSpec('interval', { interval: 4, unit: 'h' })).toBe('every:4h');
  });
  it('weekday', () => {
    expect(buildScheduleSpec('weekday', { weekday: 'sat', time: '10:00' })).toBe('sat@10:00');
  });
});

describe('runsToday', () => {
  it('counts only runs bucketed to today, excluding resume markers', () => {
    const today = localDayBucket();
    const runs = [
      run({ dayBucket: today }),
      run({ dayBucket: today, outcome: 'failed' }),
      run({ dayBucket: today, outcome: 'resume' }),
      run({ dayBucket: '2000-01-01' }),
    ];
    expect(runsToday(runs)).toBe(2);
  });
});

describe('failureStreak', () => {
  it('counts trailing failures since the last ok/resume', () => {
    expect(failureStreak([run({ outcome: 'ok' }), run({ outcome: 'failed' }), run({ outcome: 'failed' })])).toBe(2);
  });
  it('resets on a resume marker', () => {
    expect(failureStreak([run({ outcome: 'failed' }), run({ outcome: 'resume' }), run({ outcome: 'failed' })])).toBe(1);
  });
  it('is zero when the latest run is a success', () => {
    expect(failureStreak([run({ outcome: 'failed' }), run({ outcome: 'ok' })])).toBe(0);
  });
});

describe('lastExecutedRun', () => {
  it('skips resume markers to find the newest real run', () => {
    const real = run({ id: 'real', outcome: 'ok' });
    const runs = [run({ outcome: 'failed' }), real, run({ id: 'r', outcome: 'resume' })];
    expect(lastExecutedRun(runs)?.id).toBe('real');
  });
  it('returns null with no executed runs', () => {
    expect(lastExecutedRun([run({ outcome: 'resume' })])).toBeNull();
    expect(lastExecutedRun([])).toBeNull();
  });
});

describe('verifyLabel', () => {
  it('labels each tri-state', () => {
    expect(verifyLabel('green')).toBe('Verify passed');
    expect(verifyLabel('red')).toBe('Verify failed');
    expect(verifyLabel('none')).toBe('No verify');
  });
});
