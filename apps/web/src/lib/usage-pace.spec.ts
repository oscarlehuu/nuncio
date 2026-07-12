import { describe, expect, it } from 'vitest';
import { deriveUsagePace } from './usage-pace';

describe('deriveUsagePace', () => {
  it('shows reserve when usage is slower than the elapsed window pace', () => {
    const nowMs = Date.parse('2026-07-11T12:00:00.000Z');
    const resetMs = Date.parse('2026-07-11T15:00:00.000Z'); // 3h left of 5h → 40% elapsed
    const pace = deriveUsagePace({
      nowMs,
      remainingPercent: 85,
      resetsAt: new Date(resetMs).toISOString(),
      windowDurationMins: 300,
    });
    expect(pace?.status).toBe('ahead');
    expect(pace?.amountText).toMatch(/reserve/);
    expect(pace?.etaText).toBe('Lasts until reset');
  });

  it('shows deficit and run-out timing when usage is faster than pace', () => {
    const nowMs = Date.parse('2026-07-11T11:00:00.000Z');
    const resetMs = Date.parse('2026-07-11T15:00:00.000Z'); // 4h left of 5h → 20% elapsed
    const pace = deriveUsagePace({
      nowMs,
      remainingPercent: 40, // 60% used already vs ~20% expected
      resetsAt: new Date(resetMs).toISOString(),
      windowDurationMins: 300,
    });
    expect(pace?.status).toBe('behind');
    expect(pace?.amountText).toMatch(/deficit/);
    expect(pace?.etaText).toMatch(/^Runs out in /);
  });

  it('returns null without reset or duration', () => {
    expect(
      deriveUsagePace({ remainingPercent: 50, resetsAt: '2026-07-11T15:00:00.000Z' }),
    ).toBeNull();
  });
});
