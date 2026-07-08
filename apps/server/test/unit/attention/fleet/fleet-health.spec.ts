import { describe, expect, it } from 'bun:test';
import { foldHealth } from '../../../../src/attention/fleet/fleet';
import type { FleetProjectInput } from '../../../../src/attention/fleet/fleet.types';
import type { AttentionItemDto } from '../../../../src/attention/attention.types';

/**
 * Fleet health fold (rung 3 sub-phase C) — pure, table-testable, RED until
 * implemented. red = any HIGH-bucket (sev>=4) open item; yellow = any open item;
 * else green. Monotone; reasons[] explains the color.
 */
function openItem(kind: string, id = 'i'): AttentionItemDto {
  return {
    id, kind, subjectId: 's', projectPath: '/p', severity: 0, title: kind, payload: null,
    status: 'open', acknowledgedAt: null, suppressReraise: false, createdAt: 0, updatedAt: 0, resolvedAt: null,
  };
}

function input(over: Partial<FleetProjectInput> = {}): FleetProjectInput {
  return {
    path: over.path ?? '/p', name: over.name ?? 'p', weight: over.weight ?? 1,
    openItems: over.openItems ?? [], runningSessions: over.runningSessions ?? 0,
    activeLoops: over.activeLoops ?? 0, openPRs: over.openPRs ?? 0,
    lastVerify: over.lastVerify ?? 'none', lastActivityAt: over.lastActivityAt ?? null,
  };
}

describe('foldHealth', () => {
  it('GREEN when nothing is open', () => {
    expect(foldHealth(input()).health).toBe('green');
  });

  it('YELLOW when an open item exists but none is high-bucket', () => {
    for (const kind of ['pr-review', 'anomaly', 'zombie-session', 'session-empty-diff', 'loop-failing']) {
      expect(foldHealth(input({ openItems: [openItem(kind)] })).health).toBe('yellow');
    }
  });

  it('RED when any open item is high-bucket (sev >= tripped-breaker)', () => {
    for (const kind of ['tripped-breaker', 'verify-dead', 'credential-expiring', 'permission']) {
      expect(foldHealth(input({ openItems: [openItem(kind)] })).health).toBe('red');
    }
  });

  it('is monotone — one red item beats several yellow ones', () => {
    const items = [openItem('pr-review', 'a'), openItem('anomaly', 'b'), openItem('permission', 'c')];
    expect(foldHealth(input({ openItems: items })).health).toBe('red');
  });

  it('reasons[] names what drove the color', () => {
    const red = foldHealth(input({ openItems: [openItem('permission', 'a'), openItem('verify-dead', 'b')] }));
    expect(red.reasons.join(' ')).toMatch(/need|you|2/i);

    const yellow = foldHealth(input({ openItems: [openItem('pr-review')], openPRs: 1 }));
    expect(yellow.reasons.length).toBeGreaterThan(0);

    expect(foldHealth(input()).reasons).toEqual([]); // green → no reasons
  });

  it('counts block reflects the inputs', () => {
    const c = foldHealth(input({ openItems: [openItem('pr-review'), openItem('anomaly')], runningSessions: 2, activeLoops: 3, openPRs: 1 })).counts;
    expect(c).toEqual({ openAttention: 2, runningSessions: 2, activeLoops: 3, openPRs: 1 });
  });

  it('a project with zero signals folds to green with empty reasons (never crashes)', () => {
    const r = foldHealth(input());
    expect(r.health).toBe('green');
    expect(r.reasons).toEqual([]);
    expect(r.counts.openAttention).toBe(0);
  });
});
