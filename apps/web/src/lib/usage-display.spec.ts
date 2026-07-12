import { describe, expect, it } from 'vitest';
import {
  displayPercent,
  formatPercentLabel,
  freshestUpdatedAt,
  formatResetCountdown,
  isNotStartedLimit,
  isUsageProviderId,
  pinActiveProvider,
  primaryUsageLimit,
  resolveUsageProvider,
  usageNeedsAuthHint,
  usageSignInCommand,
} from './usage-display';
import type { UsageSnapshotDto } from './usage-api';

const base = (partial: Partial<UsageSnapshotDto> & Pick<UsageSnapshotDto, 'provider'>): UsageSnapshotDto => ({
  updatedAt: new Date().toISOString(),
  limits: [],
  usageLines: [],
  source: 'test',
  status: 'ok',
  ...partial,
});

describe('usage-display', () => {
  it('recognizes quota providers only', () => {
    expect(isUsageProviderId('claude')).toBe(true);
    expect(isUsageProviderId('pi')).toBe(false);
  });

  it('maps session provider + model to a usage probe', () => {
    expect(resolveUsageProvider('claude')).toBe('claude');
    expect(resolveUsageProvider('codex')).toBe('codex');
    expect(resolveUsageProvider('cursor')).toBe('cursor');
    expect(resolveUsageProvider('pi', 'cliproxy:claude-opus-4-8')).toBe('claude');
    expect(resolveUsageProvider('pi', 'anthropic:claude-sonnet-4-6')).toBe('claude');
    expect(resolveUsageProvider('pi', 'openai:gpt-5')).toBe(null);
    expect(resolveUsageProvider('pi')).toBe(null);
  });

  it('returns sign-in commands and needs-auth hints', () => {
    expect(usageSignInCommand('codex')).toBe('codex login');
    expect(usageNeedsAuthHint('claude')).toMatch(/claude/);
  });

  it('picks the session window as primary', () => {
    const snap = base({
      provider: 'claude',
      limits: [
        { window: 'Weekly', usedPercent: 40, windowDurationMins: 10_080 },
        { window: 'Session', usedPercent: 3, windowDurationMins: 300 },
      ],
    });
    expect(primaryUsageLimit(snap)?.window).toBe('Session');
    expect(primaryUsageLimit(snap)?.usedPercent).toBe(3);
  });

  it('formats reset countdown', () => {
    const now = Date.parse('2026-07-11T10:00:00.000Z');
    expect(formatResetCountdown('2026-07-11T14:00:00.000Z', now)).toBe('4h');
  });

  it('pins the active provider first', () => {
    const list = [
      base({ provider: 'claude' }),
      base({ provider: 'codex' }),
      base({ provider: 'cursor' }),
    ];
    expect(pinActiveProvider(list, 'codex').map((s) => s.provider)).toEqual([
      'codex',
      'claude',
      'cursor',
    ]);
  });

  it('switches display percent between used and left', () => {
    expect(displayPercent(3, 'used')).toBe(3);
    expect(displayPercent(3, 'left')).toBe(97);
    expect(formatPercentLabel(3, 'left')).toBe('97% left');
    expect(formatPercentLabel(3, 'used')).toBe('3% used');
    expect(formatPercentLabel(0, 'used', { notStarted: true })).toBe('Not started');
  });

  it('marks session 0% as not started', () => {
    expect(isNotStartedLimit({ window: 'Session', usedPercent: 0 })).toBe(true);
    expect(isNotStartedLimit({ window: 'Weekly', usedPercent: 0 })).toBe(false);
  });

  it('picks the freshest ok updatedAt across providers', () => {
    expect(
      freshestUpdatedAt([
        base({ provider: 'claude', updatedAt: '2026-07-11T10:00:00.000Z' }),
        base({ provider: 'codex', updatedAt: '2026-07-11T10:05:00.000Z' }),
        base({
          provider: 'cursor',
          status: 'needs-auth',
          updatedAt: '2026-07-11T11:00:00.000Z',
        }),
      ]),
    ).toBe('2026-07-11T10:05:00.000Z');
  });
});
