import { describe, it, expect } from 'vitest';
import { openTargetFor } from '../lib/attention-kind';
import type { AttentionItemDto } from '../lib/api';

function item(partial: Partial<AttentionItemDto>): AttentionItemDto {
  return {
    id: 'i',
    kind: partial.kind ?? 'permission',
    subjectId: partial.subjectId ?? 'subj',
    projectPath: null,
    severity: 0,
    title: 't',
    payload: partial.payload ?? null,
    status: 'open',
    acknowledgedAt: null,
    createdAt: 0,
    updatedAt: 0,
    resolvedAt: null,
  };
}

describe('openTargetFor', () => {
  it('permission → the session in its payload', () => {
    expect(openTargetFor(item({ kind: 'permission', payload: { sessionId: 's9' } }))).toEqual({ to: '/session/s9' });
  });
  it('verify-dead → the session (subjectId when no payload sessionId)', () => {
    expect(openTargetFor(item({ kind: 'verify-dead', subjectId: 'sess-1', payload: null }))).toEqual({
      to: '/session/sess-1',
    });
  });
  it('tripped-breaker → the loop', () => {
    expect(openTargetFor(item({ kind: 'tripped-breaker', payload: { loopId: 'l3' } }))).toEqual({
      to: '/autopilot/l3',
    });
  });
  it('pr-review → the external PR url', () => {
    expect(openTargetFor(item({ kind: 'pr-review', payload: { url: 'https://ex/pr/42' } }))).toEqual({
      href: 'https://ex/pr/42',
    });
  });
  it('pr-review with no url → no target (button hidden)', () => {
    expect(openTargetFor(item({ kind: 'pr-review', payload: {} }))).toBeNull();
  });
  it('unknown kind → session if payload carries one, else null', () => {
    expect(openTargetFor(item({ kind: 'mystery', payload: { sessionId: 's1' } }))).toEqual({ to: '/session/s1' });
    expect(openTargetFor(item({ kind: 'mystery', payload: null }))).toBeNull();
  });
});
