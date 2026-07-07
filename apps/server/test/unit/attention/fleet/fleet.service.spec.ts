import { beforeEach, describe, expect, it } from 'bun:test';
import { FleetService, type FleetSources } from '../../../../src/attention/fleet/fleet.service';
import type { AttentionItemDto } from '../../../../src/attention/attention.types';

/**
 * Fleet derive-on-demand (rung 3 sub-phase C) — RED until implemented. Population
 * = configured ∪ active, deduped by path; each row folds health + counts + topItem
 * + lastActivity, then ordered red-first. Driven by a fake `sources` seam.
 */
describe('FleetService', () => {
  let svc: FleetService;

  function openItem(kind: string, projectPath: string, id = kind): AttentionItemDto {
    return {
      id, kind, subjectId: id, projectPath, severity: 0, title: kind, payload: null,
      status: 'open', acknowledgedAt: null, suppressReraise: false, createdAt: 0, updatedAt: 0, resolvedAt: null,
    };
  }

  function withSources(over: Partial<FleetSources>): void {
    svc.sources = () => ({
      configured: over.configured ?? [],
      activePaths: over.activePaths ?? [],
      openAttention: over.openAttention ?? [],
      runningSessionsByPath: over.runningSessionsByPath ?? (() => 0),
      activeLoopsByPath: over.activeLoopsByPath ?? (() => 0),
      openPRsByPath: over.openPRsByPath ?? (async () => 0),
      lastVerifyByPath: over.lastVerifyByPath ?? (() => 'none'),
      lastActivityByPath: over.lastActivityByPath ?? (() => null),
    });
  }

  beforeEach(() => {
    svc = new FleetService();
  });

  it('populates the UNION of configured projects and recently-active paths, deduped', async () => {
    withSources({
      configured: [{ path: '/a', name: 'a', weight: 1 }, { path: '/b', name: 'b', weight: 1 }],
      activePaths: ['/b', '/c'], // /b overlaps config; /c is unconfigured-but-active
    });
    const paths = (await svc.list()).map((r) => r.path).sort();
    expect(paths).toEqual(['/a', '/b', '/c']); // deduped union
  });

  it('a configured project with no activity still appears (green)', async () => {
    withSources({ configured: [{ path: '/idle', name: 'idle', weight: 1 }] });
    const rows = await svc.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.health).toBe('green');
  });

  it('an unconfigured active path appears with basename name + default weight 1', async () => {
    withSources({ activePaths: ['/repos/widget'] });
    const row = (await svc.list())[0]!;
    expect(row.path).toBe('/repos/widget');
    expect(row.name).toBe('widget'); // basename
    expect(row.weight).toBe(1);
  });

  it('topItem is the highest-ranked open item for the project', async () => {
    withSources({
      configured: [{ path: '/p', name: 'p', weight: 1 }],
      openAttention: [openItem('pr-review', '/p', 'pr'), openItem('permission', '/p', 'perm')],
    });
    const row = (await svc.list())[0]!;
    expect(row.topItem!.id).toBe('perm'); // permission outranks pr-review
    expect(row.health).toBe('red');
  });

  it('tolerates an unknown/legacy attention kind (counts it, never crashes)', async () => {
    withSources({
      configured: [{ path: '/p', name: 'p', weight: 1 }],
      openAttention: [openItem('some-future-kind', '/p')],
    });
    const row = (await svc.list())[0]!;
    expect(row.counts.openAttention).toBe(1);
    expect(row.health).toBe('yellow'); // unknown kind → not high-bucket → yellow
  });

  it('orders red projects before green', async () => {
    withSources({
      configured: [{ path: '/green', name: 'g', weight: 9 }, { path: '/red', name: 'r', weight: 1 }],
      openAttention: [openItem('permission', '/red')],
    });
    expect((await svc.list()).map((r) => r.path)).toEqual(['/red', '/green']);
  });
});
