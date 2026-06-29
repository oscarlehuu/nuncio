import { describe, expect, it } from 'vitest';
import { calculateContextUsage, formatTokens, DEFAULT_CONTEXT_WINDOW } from './use-context-usage';
import type { SessionEvent } from './api';

function ev(seq: number, type: string, payload: Record<string, unknown>): SessionEvent {
  return { seq, type, payload, createdAt: seq };
}

describe('calculateContextUsage', () => {
  it('counts conversation tokens from user + assistant messages', () => {
    const usage = calculateContextUsage([
      ev(1, 'user_message', { text: 'Hello world' }),
      ev(2, 'assistant_message', { text: 'Hi there, how can I help?' }),
    ]);
    const convo = usage.breakdown.find((b) => b.label === 'Conversation');
    expect(convo).toBeDefined();
    expect(convo!.tokens).toBeGreaterThan(0);
  });

  it('counts tool call tokens from tool_start + tool_end', () => {
    const usage = calculateContextUsage([
      ev(1, 'tool_start', { tool: 'Read', input: { path: '/foo.ts' } }),
      ev(2, 'tool_end', { tool: 'Read', output: 'file content here' }),
    ]);
    const tools = usage.breakdown.find((b) => b.label === 'Tool calls');
    expect(tools).toBeDefined();
    expect(tools!.tokens).toBeGreaterThan(0);
  });

  it('counts thinking tokens from thinking_delta', () => {
    const usage = calculateContextUsage([
      ev(1, 'thinking_delta', { delta: 'Let me think about this...' }),
    ]);
    const thinking = usage.breakdown.find((b) => b.label === 'Thinking');
    expect(thinking).toBeDefined();
    expect(thinking!.tokens).toBeGreaterThan(0);
  });

  it('includes system-level overhead in total even with no events', () => {
    const usage = calculateContextUsage([]);
    expect(usage.breakdown.find((b) => b.label === 'System prompt')).toBeDefined();
    expect(usage.total).toBeGreaterThan(0);
  });

  it('calculates percentage of context window', () => {
    const usage = calculateContextUsage([]);
    expect(usage.percentage).toBeGreaterThanOrEqual(0);
    expect(usage.percentage).toBeLessThanOrEqual(100);
    expect(usage.window).toBe(DEFAULT_CONTEXT_WINDOW);
  });

  it('shows fixed system categories even with no events', () => {
    const usage = calculateContextUsage([]);
    const labels = usage.breakdown.map((b) => b.label);
    expect(labels).toContain('System prompt');
    expect(labels).toContain('Tool definitions');
    expect(labels).toContain('Rules');
    expect(labels).toContain('Skills');
  });
});

describe('formatTokens', () => {
  it('formats thousands with K suffix', () => {
    expect(formatTokens(1500)).toBe('1.5K');
    expect(formatTokens(20000)).toBe('20.0K');
  });

  it('formats small numbers as-is', () => {
    expect(formatTokens(500)).toBe('500');
    expect(formatTokens(0)).toBe('0');
  });
});
