import { describe, expect, it } from 'vitest';
import {
  findUsageSnapshotForProvider,
  resolveUsageProvider,
  usageNeedsAuthHint,
  usageSignInCommand,
} from './usage-resolve';

describe('usage-resolve', () => {
  it('resolves direct usage providers', () => {
    expect(resolveUsageProvider('claude')).toBe('claude');
    expect(resolveUsageProvider('codex')).toBe('codex');
    expect(resolveUsageProvider('cursor')).toBe('cursor');
  });

  it('maps Pi Claude/cliproxy models to claude quota', () => {
    expect(resolveUsageProvider('pi', 'cliproxyapi:claude-opus-4-8')).toBe('claude');
    expect(resolveUsageProvider('pi', 'cliproxy:claude-sonnet-4-6')).toBe('claude');
    expect(resolveUsageProvider('pi', 'anthropic:claude-opus-4')).toBe('claude');
    expect(resolveUsageProvider('pi', 'fable-5')).toBe('claude');
  });

  it('hides chip for non-Claude Pi models', () => {
    expect(resolveUsageProvider('pi', 'openai:gpt-5')).toBe(null);
    expect(resolveUsageProvider('pi', '')).toBe(null);
  });

  it('does not substitute another provider snapshot when no quota provider resolves', () => {
    const snapshots = [
      {
        provider: 'claude' as const,
        updatedAt: '2026-07-12T00:00:00.000Z',
        limits: [{ window: 'Session', usedPercent: 25 }],
        usageLines: [],
        source: 'test',
        status: 'ok' as const,
      },
    ];

    expect(findUsageSnapshotForProvider(snapshots, null)).toBe(null);
    expect(findUsageSnapshotForProvider(snapshots, 'codex')).toBe(null);
    expect(findUsageSnapshotForProvider(snapshots, 'claude')).toBe(snapshots[0]);
  });

  it('exposes sign-in commands', () => {
    expect(usageSignInCommand('claude')).toBe('claude');
    expect(usageSignInCommand('codex')).toBe('codex login');
    expect(usageNeedsAuthHint('cursor')).toMatch(/Cursor/);
  });
});
