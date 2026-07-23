import { describe, it, expect } from 'vitest';
import { attentionGroupLabel, attentionKindMeta, openTargetFor } from '../lib/attention-kind';
import type { AttentionItemDto } from '../lib/api';

function item(partial: Partial<AttentionItemDto>): AttentionItemDto {
  return {
    id: 'i',
    kind: partial.kind ?? 'permission',
    subjectId: partial.subjectId ?? 'subj',
    projectPath: partial.projectPath ?? null,
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
  it('pr-review → the in-app forge PR route when project and number are present', () => {
    expect(
      openTargetFor(item({
        kind: 'pr-review',
        projectPath: '/Users/me/nuncio',
        payload: { projectPath: '/Users/me/nuncio', number: 42, url: 'https://ex/pr/42' },
      })),
    ).toEqual({
      to: '/forge/pr?path=%2FUsers%2Fme%2Fnuncio&number=42',
    });
  });

  it('pr-review falls back to the item projectPath when payload only carries the number', () => {
    expect(openTargetFor(item({ kind: 'pr-review', projectPath: '/repo/app', payload: { number: 7 } }))).toEqual({
      to: '/forge/pr?path=%2Frepo%2Fapp&number=7',
    });
  });

  it('pr-review with only a url keeps the external fallback', () => {
    expect(openTargetFor(item({ kind: 'pr-review', payload: { url: 'https://ex/pr/42' } }))).toEqual({
      href: 'https://ex/pr/42',
    });
  });

  it('pr-review with no route data → no target (button hidden)', () => {
    expect(openTargetFor(item({ kind: 'pr-review', payload: {} }))).toBeNull();
  });
  it('pr-feedback → the in-app forge PR route using the item project path and payload number', () => {
    expect(
      openTargetFor(item({
        kind: 'pr-feedback',
        projectPath: '/Users/me/nuncio',
        payload: { number: 12, url: 'https://ex/pr/12', reason: 'untrusted-author' },
      })),
    ).toEqual({ to: '/forge/pr?path=%2FUsers%2Fme%2Fnuncio&number=12' });
  });

  it('pr-feedback with only a url keeps the external fallback', () => {
    expect(openTargetFor(item({ kind: 'pr-feedback', payload: { url: 'https://ex/pr/12' } }))).toEqual({
      href: 'https://ex/pr/12',
    });
  });

  it('unknown kind → session if payload carries one, else null', () => {
    expect(openTargetFor(item({ kind: 'mystery', payload: { sessionId: 's1' } }))).toEqual({ to: '/session/s1' });
    expect(openTargetFor(item({ kind: 'mystery', payload: null }))).toBeNull();
  });
});

describe('attentionKindMeta', () => {
  it('uses plain-language labels for plans and failing checks', () => {
    expect(attentionKindMeta('dispatcher-proposal').label).toBe('Plan');
    expect(attentionKindMeta('verify-dead').label).toBe('Checks failing');
    expect(attentionKindMeta('tripped-breaker').label).toBe('Autopilot paused');
    expect(attentionGroupLabel('tripped-breaker', 2)).toBe('2 paused standing tasks');
  });

  it('uses severity-appropriate Autopilot labels for stuck and failing conditions', () => {
    expect(attentionKindMeta('loop-stuck')).toMatchObject({
      label: 'Autopilot stuck',
      tone: 'warning',
    });
    expect(attentionKindMeta('loop-failing')).toMatchObject({
      label: 'Autopilot failing',
      tone: 'neutral',
    });
    expect(attentionGroupLabel('loop-stuck', 2)).toBe('2 stuck Autopilot runs');
    expect(attentionGroupLabel('loop-failing', 2)).toBe('2 failing Autopilot tasks');
  });
});
