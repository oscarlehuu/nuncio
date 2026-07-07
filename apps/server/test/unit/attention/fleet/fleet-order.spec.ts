import { describe, expect, it } from 'bun:test';
import { orderFleet, topAttentionItem } from '../../../../src/attention/fleet/fleet';
import type { FleetRow } from '../../../../src/attention/fleet/fleet.types';
import type { AttentionItemDto } from '../../../../src/attention/attention.types';

/**
 * Fleet ordering (rung 3 sub-phase C) — RED until implemented. Deterministic total
 * order: red first → weight DESC → lastActivityAt DESC → path ASC (stable).
 */
function row(over: Partial<FleetRow>): FleetRow {
  return {
    path: over.path ?? '/p', name: over.name ?? 'p', weight: over.weight ?? 1,
    health: over.health ?? 'green', reasons: [], topItem: over.topItem ?? null,
    counts: { openAttention: 0, runningSessions: 0, activeLoops: 0, openPRs: 0 },
    lastActivityAt: over.lastActivityAt ?? null,
  };
}

function item(kind: string, id: string): AttentionItemDto {
  return {
    id, kind, subjectId: 's', projectPath: '/p', severity: 0, title: kind, payload: null,
    status: 'open', acknowledgedAt: null, suppressReraise: false, createdAt: 0, updatedAt: 0, resolvedAt: null,
  };
}

describe('orderFleet', () => {
  it('puts red projects first regardless of weight', () => {
    const rows = [
      row({ path: '/green', health: 'green', weight: 9 }),
      row({ path: '/red', health: 'red', weight: 1 }),
      row({ path: '/yellow', health: 'yellow', weight: 5 }),
    ];
    expect(orderFleet(rows).map((r) => r.path)).toEqual(['/red', '/yellow', '/green']);
  });

  it('within a health tier, higher weight leads, then more-recent activity, then path', () => {
    const rows = [
      row({ path: '/b', health: 'red', weight: 5, lastActivityAt: 100 }),
      row({ path: '/a', health: 'red', weight: 5, lastActivityAt: 200 }), // same weight, newer
      row({ path: '/c', health: 'red', weight: 9, lastActivityAt: 1 }),   // higher weight
    ];
    expect(orderFleet(rows).map((r) => r.path)).toEqual(['/c', '/a', '/b']);
  });

  it('is a stable total order — ordering the same set twice matches', () => {
    const rows = [
      row({ path: '/x', health: 'yellow', weight: 1, lastActivityAt: 1 }),
      row({ path: '/y', health: 'yellow', weight: 1, lastActivityAt: 1 }),
    ];
    expect(orderFleet(rows).map((r) => r.path)).toEqual(orderFleet(rows).map((r) => r.path));
  });
});

describe('topAttentionItem', () => {
  it('returns the highest-ranked open item (reuses the severity fold)', () => {
    const items = [item('pr-review', 'pr'), item('permission', 'perm'), item('anomaly', 'an')];
    expect(topAttentionItem(items)!.id).toBe('perm'); // permission is the top bucket
  });

  it('returns null when there are no open items', () => {
    expect(topAttentionItem([])).toBeNull();
  });
});
