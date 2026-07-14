import { describe, expect, it } from 'bun:test';
import { parseCodexUsage } from '../../../src/usage/fetchers/codex.fetcher';

describe('parseCodexUsage', () => {
  const nowMs = Date.parse('2026-07-14T00:00:00.000Z');

  it('maps primary and secondary windows plus spark limits', () => {
    const snapshot = parseCodexUsage({
      nowMs,
      headers: {
        'x-codex-primary-used-percent': '33',
        'x-codex-credits-balance': '12.5',
      },
      json: {
        plan_type: 'plus',
        rate_limit: {
          primary_window: { used_percent: 33, reset_after_seconds: 3600, limit_window_seconds: 18_000 },
          secondary_window: { used_percent: 12, reset_at: 1_752_000_000 },
          additional_rate_limits: [
            {
              name: 'spark',
              primary_window: { used_percent: 80, reset_after_seconds: 600 },
              secondary_window: { used_percent: 5, reset_after_seconds: 604_800 },
            },
          ],
        },
        credits: { balance: 12.5, has_credits: true },
        rate_limit_reset_credits: { available_count: 2 },
      },
    });

    expect(snapshot.provider).toBe('codex');
    expect(snapshot.status).toBe('ok');
    expect(snapshot.planName).toBe('Plus');
    expect(snapshot.limits.map((limit) => limit.window)).toEqual(
      expect.arrayContaining(['Session', 'Weekly', 'Spark', 'Spark Weekly']),
    );
    expect(snapshot.usageLines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: 'Credits' }),
        expect.objectContaining({ label: 'Rate Limit Resets' }),
      ]),
    );
  });

  it('skips empty windows and credits when disabled', () => {
    const snapshot = parseCodexUsage({
      nowMs,
      json: {
        rate_limit: { primary_window: {}, secondary_window: {} },
        credits: { balance: 0, has_credits: false },
      },
    });

    expect(snapshot.limits).toEqual([]);
    expect(snapshot.usageLines).toEqual([]);
  });
});
