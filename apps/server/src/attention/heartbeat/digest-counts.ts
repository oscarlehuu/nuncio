import { dayBucket } from '../../loops/loop-accounting';
import type { AttentionItemDto } from '../attention.types';
import type { DigestCounts } from './heartbeat.types';

/** A settled loop run (only createdAt + outcome are read). */
export interface DigestLoopRun {
  createdAt: number;
  outcome: string;
  dayBucket: string;
}

/** A session snapshot (status + createdAt) for completed / needs-you counts. */
export interface DigestSession {
  id: string;
  status: string;
  createdAt: number;
}

export interface DigestCountSources {
  loopRuns: DigestLoopRun[];
  attentionItems: AttentionItemDto[];
  sessions: DigestSession[];
  latestEventAt: (sessionId: string) => number | null;
  maxRunsPerDay: number;
}

const inWindow = (t: number, from: number, to: number): boolean => t >= from && t < to;

/**
 * Fold REAL window-scoped counts from durable rows for the digest (finding #5) —
 * every exposed number is true, never a fake all-clear. Pure: the caller supplies
 * the rows + window + now; deltas are `[from, to)`, snapshots are at `to`/today.
 */
export function gatherDigestCounts(
  sources: DigestCountSources,
  from: number,
  to: number,
  now: number,
): DigestCounts {
  let runsOk = 0;
  let runsFailed = 0;
  for (const run of sources.loopRuns) {
    if (!inWindow(run.createdAt, from, to)) continue;
    if (run.outcome === 'ok') runsOk += 1;
    else if (run.outcome === 'failed') runsFailed += 1;
  }

  let attentionRaised = 0;
  let attentionResolved = 0;
  let prsOpened = 0;
  for (const item of sources.attentionItems) {
    if (inWindow(item.createdAt, from, to)) {
      attentionRaised += 1;
      if (item.kind === 'pr-review') prsOpened += 1;
    }
    if (item.resolvedAt !== null && inWindow(item.resolvedAt, from, to)) {
      attentionResolved += 1;
    }
  }

  // Sessions: "completed" = last activity landed in-window while IDLE/ARCHIVED;
  // "needs-you" = the current count of RUNNING sessions blocked on the founder
  // (surfaced by open permission items — a snapshot, not a delta).
  let sessionsCompleted = 0;
  const needsYouSessions = new Set<string>();
  for (const item of sources.attentionItems) {
    if (item.status !== 'open') continue;
    if (item.kind === 'permission' || item.kind === 'verify-dead') {
      const sid = String((item.payload as { sessionId?: string } | null)?.sessionId ?? '');
      if (sid) needsYouSessions.add(sid);
    }
  }
  for (const s of sources.sessions) {
    if (s.status === 'IDLE' || s.status === 'ARCHIVED') {
      const last = sources.latestEventAt(s.id) ?? s.createdAt;
      if (inWindow(last, from, to)) sessionsCompleted += 1;
    }
  }

  // Day-budget usage: a real fire (ok/failed/pending) consumes a slot; bookkeeping
  // rows (budget-exhausted, resume, skipped-overlap) do not — mirrors runsOnDay.
  const today = dayBucket(now);
  const runsToday = sources.loopRuns.filter(
    (r) =>
      r.dayBucket === today &&
      (r.outcome === 'ok' || r.outcome === 'failed' || r.outcome === 'pending'),
  ).length;

  return {
    runsOk,
    runsFailed,
    prsOpened,
    attentionRaised,
    attentionResolved,
    sessionsCompleted,
    sessionsNeedsYou: needsYouSessions.size,
    runsToday,
    cap: sources.maxRunsPerDay,
  };
}
