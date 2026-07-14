import { describe, expect, it } from 'bun:test';
import { parseClaudeUsage } from '../../../src/usage/fetchers/claude.fetcher';

describe('parseClaudeUsage', () => {
  const nowMs = Date.parse('2026-07-14T00:00:00.000Z');

  it('maps session, weekly, and model-specific windows', () => {
    const snapshot = parseClaudeUsage({
      nowMs,
      planName: 'Pro (5x)',
      json: {
        five_hour: { utilization: 42, resets_at: '2026-07-14T05:00:00.000Z' },
        seven_day: { utilization: 10, resets_at: '2026-07-21T00:00:00.000Z' },
        limits: [{ name: 'fable', utilization: 75, resets_at: '2026-07-21T00:00:00.000Z' }],
        extra_usage: { is_enabled: true, used_credits: 250, monthly_limit: 1000 },
      },
    });

    expect(snapshot.provider).toBe('claude');
    expect(snapshot.status).toBe('ok');
    expect(snapshot.planName).toBe('Pro (5x)');
    expect(snapshot.limits.map((limit) => limit.window)).toEqual(
      expect.arrayContaining(['Session', 'Weekly', 'Fable']),
    );
    expect(snapshot.usageLines).toEqual(
      expect.arrayContaining([expect.objectContaining({ label: 'Extra usage' })]),
    );
  });

  it('omits empty windows and extra usage when disabled', () => {
    const snapshot = parseClaudeUsage({
      nowMs,
      json: {
        five_hour: {},
        extra_usage: { is_enabled: false, used_credits: 100 },
      },
    });

    expect(snapshot.limits).toEqual([]);
    expect(snapshot.usageLines).toEqual([]);
  });
});
