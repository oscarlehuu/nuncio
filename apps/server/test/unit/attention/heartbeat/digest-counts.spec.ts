import { describe, expect, it } from 'bun:test';
import { gatherDigestCounts, type DigestCountSources } from '../../../../src/attention/heartbeat/digest-counts';
import type { AttentionItemDto } from '../../../../src/attention/attention.types';

/**
 * Real digest counts (finding #5) — every exposed number must be true. Pure fold
 * over durable rows; deltas are [from, to), snapshots are at `now`/today.
 */
function attItem(over: Partial<AttentionItemDto>): AttentionItemDto {
  return {
    id: over.id ?? 'a', kind: over.kind ?? 'anomaly', subjectId: over.subjectId ?? 's',
    projectPath: over.projectPath ?? null, severity: 1, title: 't', payload: over.payload ?? null,
    status: over.status ?? 'open', acknowledgedAt: null, suppressReraise: false,
    createdAt: over.createdAt ?? 0, updatedAt: 0, resolvedAt: over.resolvedAt ?? null,
  };
}

const DAY = 24 * 60 * 60 * 1000;

describe('gatherDigestCounts', () => {
  it('counts loop runs by outcome within the window only', () => {
    const now = 10 * DAY;
    const sources: DigestCountSources = {
      loopRuns: [
        { createdAt: 100, outcome: 'ok', dayBucket: 'x' },       // in window
        { createdAt: 200, outcome: 'failed', dayBucket: 'x' },   // in window
        { createdAt: 999, outcome: 'ok', dayBucket: 'x' },       // OUT of window
        { createdAt: 150, outcome: 'pending', dayBucket: 'x' },  // not settled → not ok/failed
      ],
      attentionItems: [],
      sessions: [],
      latestEventAt: () => null,
      maxRunsPerDay: 24,
    };
    const c = gatherDigestCounts(sources, 0, 500, now);
    expect(c.runsOk).toBe(1);
    expect(c.runsFailed).toBe(1);
  });

  it('counts attention raised (created in window) + resolved (resolvedAt in window) + PRs', () => {
    const sources: DigestCountSources = {
      loopRuns: [],
      attentionItems: [
        attItem({ id: '1', kind: 'pr-review', createdAt: 100 }),           // raised + PR
        attItem({ id: '2', kind: 'permission', createdAt: 200, status: 'resolved', resolvedAt: 300 }), // raised + resolved
        attItem({ id: '3', kind: 'anomaly', createdAt: 9_999 }),           // raised OUT of window
      ],
      sessions: [],
      latestEventAt: () => null,
      maxRunsPerDay: 24,
    };
    const c = gatherDigestCounts(sources, 0, 500, 0);
    expect(c.attentionRaised).toBe(2);
    expect(c.attentionResolved).toBe(1);
    expect(c.prsOpened).toBe(1);
  });

  it('needs-you = distinct sessions with an OPEN permission/verify-dead item', () => {
    const sources: DigestCountSources = {
      loopRuns: [],
      attentionItems: [
        attItem({ id: '1', kind: 'permission', status: 'open', payload: { sessionId: 'sA' } }),
        attItem({ id: '2', kind: 'verify-dead', status: 'open', payload: { sessionId: 'sA' } }), // same session
        attItem({ id: '3', kind: 'permission', status: 'open', payload: { sessionId: 'sB' } }),
      ],
      sessions: [],
      latestEventAt: () => null,
      maxRunsPerDay: 24,
    };
    expect(gatherDigestCounts(sources, 0, 1, 0).sessionsNeedsYou).toBe(2); // sA, sB
  });

  it('completed = IDLE/ARCHIVED sessions whose last activity is in the window', () => {
    const sources: DigestCountSources = {
      loopRuns: [],
      attentionItems: [],
      sessions: [
        { id: 'done', status: 'IDLE', createdAt: 0 },
        { id: 'old', status: 'IDLE', createdAt: 0 },
        { id: 'running', status: 'RUNNING', createdAt: 0 },
      ],
      latestEventAt: (id) => (id === 'done' ? 250 : id === 'old' ? 9_999 : 0),
      maxRunsPerDay: 24,
    };
    expect(gatherDigestCounts(sources, 0, 500, 0).sessionsCompleted).toBe(1); // 'done' only
  });

  it('runsToday counts real fires on today only (budget usage)', () => {
    const now = 10 * DAY;
    const { dayBucket } = require('../../../../src/loops/loop-accounting') as typeof import('../../../../src/loops/loop-accounting');
    const today = dayBucket(now);
    const sources: DigestCountSources = {
      loopRuns: [
        { createdAt: now, outcome: 'ok', dayBucket: today },
        { createdAt: now, outcome: 'pending', dayBucket: today },
        { createdAt: now, outcome: 'budget-exhausted', dayBucket: today }, // bookkeeping → not counted
        { createdAt: now, outcome: 'ok', dayBucket: 'other-day' },
      ],
      attentionItems: [],
      sessions: [],
      latestEventAt: () => null,
      maxRunsPerDay: 24,
    };
    const c = gatherDigestCounts(sources, 0, now + 1, now);
    expect(c.runsToday).toBe(2); // ok + pending on today
    expect(c.cap).toBe(24);
  });

  it('an empty world yields all-zeros (a valid, honest digest)', () => {
    const c = gatherDigestCounts(
      { loopRuns: [], attentionItems: [], sessions: [], latestEventAt: () => null, maxRunsPerDay: 24 },
      0, 1, 0,
    );
    expect(c).toEqual({
      runsOk: 0, runsFailed: 0, prsOpened: 0, attentionRaised: 0, attentionResolved: 0,
      sessionsCompleted: 0, sessionsNeedsYou: 0, runsToday: 0, cap: 24,
    });
  });
});
