import { describe, expect, it } from 'bun:test';
import { buildDigest, digestPushContent, type DigestInput } from '../../../../src/attention/heartbeat/digest';
import { emptyObservabilityMetrics } from '../../../../src/observability/observability-folds';
import type { ObservabilityRollupDto, TimelineEntryDto } from '../../../../src/observability/observability.types';

/**
 * Pure digest fold (rung 3 sub-phase B) — RED until implemented. Deltas over a
 * supplied [windowFrom, windowTo); current-state fields are snapshots. No clock,
 * no DB — order is a function of the inputs only.
 */
const input = (over: Partial<DigestInput> = {}): DigestInput => ({
  runsOk: over.runsOk ?? 3,
  runsFailed: over.runsFailed ?? 1,
  prsOpened: over.prsOpened ?? 2,
  attentionRaised: over.attentionRaised ?? 4,
  attentionResolved: over.attentionResolved ?? 2,
  openTopCount: over.openTopCount ?? 5,
  sessionsCompleted: over.sessionsCompleted ?? 6,
  sessionsNeedsYou: over.sessionsNeedsYou ?? 1,
  runsToday: over.runsToday ?? 12,
  cap: over.cap ?? 24,
  timelineEntries: over.timelineEntries ?? [],
  projectRollups: over.projectRollups ?? [],
});

function timeline(kind: TimelineEntryDto['kind'], ts: number, title: string = kind): TimelineEntryDto {
  return { id: `${kind}:${ts}`, ts, at: ts, kind, title, projectPath: '/repo/nuncio', provider: 'pi' };
}

function projectRollup(project: string, runs: number, green: number, needsYou: number): ObservabilityRollupDto {
  const metrics = emptyObservabilityMetrics();
  metrics.loops.total = runs;
  metrics.verify.passed = green;
  metrics.attention.open = needsYou;
  return { dimension: 'project', key: project, label: project, metrics };
}

describe('buildDigest', () => {
  it('folds the supplied deltas + snapshots into the digest shape', () => {
    const d = buildDigest(input(), 'morning', 1_000, 5_000);
    expect(d.variant).toBe('morning');
    expect(d.windowFrom).toBe(1_000);
    expect(d.windowTo).toBe(5_000);
    expect(d.loops).toEqual({ runsOk: 3, runsFailed: 1, prsOpened: 2 });
    expect(d.attention).toEqual({ raised: 4, resolved: 2, openTopCount: 5 });
    expect(d.sessions).toEqual({ completed: 6, needsYou: 1 });
    expect(d.budget).toEqual({ runsToday: 12, cap: 24 });
  });

  it('an empty window is a valid, non-crashing zero digest', () => {
    const d = buildDigest(
      input({
        runsOk: 0, runsFailed: 0, prsOpened: 0, attentionRaised: 0,
        attentionResolved: 0, openTopCount: 0, sessionsCompleted: 0,
        sessionsNeedsYou: 0, runsToday: 0,
      }),
      'evening',
      0,
      100,
    );
    expect(d.loops.runsOk).toBe(0);
    expect(d.sessions.needsYou).toBe(0);
    expect(d.variant).toBe('evening');
  });

  it('carries the variant so morning and evening render distinct templates', () => {
    expect(buildDigest(input(), 'morning', 0, 1).variant).toBe('morning');
    expect(buildDigest(input(), 'evening', 0, 1).variant).toBe('evening');
  });

  it('adds top timeline highlights by significance, then recency', () => {
    const d = buildDigest(
      input({
        timelineEntries: [
          timeline('session-completed', 90, 'Session completed'),
          timeline('task-failed', 80, 'Task failed'),
          timeline('breaker-tripped', 70, 'Breaker tripped'),
          timeline('session-needs-you', 60, 'Needs you'),
          timeline('task-done', 100, 'Task done'),
        ],
      }),
      'morning',
      0,
      120,
    );

    expect(d.highlights.map((h) => h.kind)).toEqual([
      'session-needs-you',
      'breaker-tripped',
      'task-failed',
      'task-done',
      'session-completed',
    ]);
  });

  it('adds per-project one-liners from observability project rollups', () => {
    const d = buildDigest(
      input({
        projectRollups: [
          projectRollup('/Users/oscar/nuncio', 6, 5, 1),
          projectRollup('unassigned', 2, 0, 0),
        ],
      }),
      'evening',
      0,
      100,
    );

    expect(d.projectLines).toEqual([
      { projectPath: '/Users/oscar/nuncio', title: 'nuncio: 6 runs, 5 green, 1 needs you' },
      { projectPath: null, title: 'unassigned: 2 runs, 0 green, 0 needs you' },
    ]);
  });

  it('empty world keeps enrichment honest and empty', () => {
    const d = buildDigest(
      input({
        runsOk: 0, runsFailed: 0, prsOpened: 0, attentionRaised: 0,
        attentionResolved: 0, openTopCount: 0, sessionsCompleted: 0,
        sessionsNeedsYou: 0, runsToday: 0, cap: 0,
      }),
      'morning',
      0,
      100,
    );

    expect(d.highlights).toEqual([]);
    expect(d.projectLines).toEqual([]);
  });
});

describe('digestPushContent', () => {
  it('renders a short phone push carrying a slotKey pointer', () => {
    const d = buildDigest(input(), 'morning', 0, 1);
    const content = digestPushContent(d, '2026-07-07:morning');
    expect(typeof content.title).toBe('string');
    expect(typeof content.body).toBe('string');
    expect(content.data.slotKey).toBe('2026-07-07:morning');
    // A push body is short — a pointer, not the whole digest.
    expect(content.body.length).toBeLessThanOrEqual(180);
  });
});
