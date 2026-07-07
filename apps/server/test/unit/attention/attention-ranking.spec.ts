import { describe, expect, it } from 'bun:test';
import {
  rankAttentionItems,
  severityForKind,
} from '../../../src/attention/attention-ranking';
import { SEVERITY_BY_KIND, type AttentionItemDto } from '../../../src/attention/attention.types';

/**
 * Pure ranker (rung 3 sub-phase A) — RED until implemented. Deterministic total
 * order for a stable phone list: severity DESC → project weight DESC → createdAt
 * ASC → id ASC. No clock/wall time — order is a function of the inputs only.
 */

let seq = 0;
function item(over: Partial<AttentionItemDto> = {}): AttentionItemDto {
  seq += 1;
  return {
    id: over.id ?? `a${seq}`,
    kind: over.kind ?? 'anomaly',
    subjectId: over.subjectId ?? `s${seq}`,
    projectPath: over.projectPath ?? null,
    severity: over.severity ?? SEVERITY_BY_KIND[(over.kind ?? 'anomaly') as never] ?? 0,
    title: over.title ?? 'needs you',
    payload: over.payload ?? null,
    status: over.status ?? 'open',
    acknowledgedAt: over.acknowledgedAt ?? null,
    suppressReraise: over.suppressReraise ?? false,
    createdAt: over.createdAt ?? 0,
    updatedAt: over.updatedAt ?? 0,
    resolvedAt: over.resolvedAt ?? null,
  };
}

describe('severityForKind', () => {
  it('maps the known kinds to their static buckets (permission highest)', () => {
    expect(severityForKind('permission')).toBe(5);
    expect(severityForKind('verify-dead')).toBe(4);
    expect(severityForKind('tripped-breaker')).toBe(3);
    expect(severityForKind('pr-review')).toBe(2);
    expect(severityForKind('anomaly')).toBe(1);
  });

  it('maps an unknown / legacy kind to 0 (ranks last, never throws)', () => {
    expect(severityForKind('some-future-kind')).toBe(0);
    expect(() => severityForKind('')).not.toThrow();
  });
});

describe('rankAttentionItems', () => {
  it('orders by severity bucket descending (permission before anomaly)', () => {
    const anomaly = item({ id: 'x', kind: 'anomaly', severity: 1 });
    const perm = item({ id: 'y', kind: 'permission', severity: 5 });
    const pr = item({ id: 'z', kind: 'pr-review', severity: 2 });
    const ranked = rankAttentionItems([anomaly, perm, pr]);
    expect(ranked.map((r) => r.id)).toEqual(['y', 'z', 'x']);
  });

  it('within a severity bucket, higher project importance weight ranks first', () => {
    const low = item({ id: 'low', kind: 'pr-review', severity: 2, projectPath: '/a' });
    const high = item({ id: 'high', kind: 'pr-review', severity: 2, projectPath: '/b' });
    const ranked = rankAttentionItems([low, high], { '/a': 1, '/b': 9 });
    expect(ranked.map((r) => r.id)).toEqual(['high', 'low']);
  });

  it('ties break by createdAt ascending then id ascending (stable, reproducible)', () => {
    const a = item({ id: 'aaa', kind: 'anomaly', severity: 1, createdAt: 100 });
    const b = item({ id: 'bbb', kind: 'anomaly', severity: 1, createdAt: 100 });
    const older = item({ id: 'zzz', kind: 'anomaly', severity: 1, createdAt: 50 });
    const ranked = rankAttentionItems([a, b, older]);
    // oldest first; equal createdAt broken by id ascending → aaa before bbb.
    expect(ranked.map((r) => r.id)).toEqual(['zzz', 'aaa', 'bbb']);
  });

  it('is a stable total order — ranking the same set twice yields the same order', () => {
    const set = [
      item({ id: 'p', kind: 'permission', severity: 5 }),
      item({ id: 'b1', kind: 'tripped-breaker', severity: 3, projectPath: '/x' }),
      item({ id: 'b2', kind: 'tripped-breaker', severity: 3, projectPath: '/y' }),
      item({ id: 'a', kind: 'anomaly', severity: 1 }),
    ];
    const weights = { '/x': 2, '/y': 5 };
    expect(rankAttentionItems(set, weights).map((r) => r.id)).toEqual(
      rankAttentionItems(set, weights).map((r) => r.id),
    );
  });

  it('an unknown-kind item ranks after every known kind (severity 0)', () => {
    const unknown = item({ id: 'u', kind: 'legacy-mystery', severity: 0 });
    const anomaly = item({ id: 'a', kind: 'anomaly', severity: 1 });
    const ranked = rankAttentionItems([unknown, anomaly]);
    expect(ranked.map((r) => r.id)).toEqual(['a', 'u']);
  });
});
