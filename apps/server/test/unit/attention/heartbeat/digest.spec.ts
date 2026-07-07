import { describe, expect, it } from 'bun:test';
import { buildDigest, digestPushContent, type DigestInput } from '../../../../src/attention/heartbeat/digest';

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
});

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
