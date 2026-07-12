import { describe, expect, it } from 'vitest';
import {
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

  it('exposes sign-in commands', () => {
    expect(usageSignInCommand('claude')).toBe('claude');
    expect(usageSignInCommand('codex')).toBe('codex login');
    expect(usageNeedsAuthHint('cursor')).toMatch(/Cursor/);
  });
});
