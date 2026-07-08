/**
 * Heartbeat (rung 3, sub-phase B) — 3 rhythm layers on the rung-2 scheduler:
 * infra self-check (15min) / fleet reconciliation (hourly) / human digest (2×/day).
 * Data-first: it PRODUCES attention items + digests; it adds no new signal store
 * beyond a tiny durable digest marker.
 */

/** Which system job a `{kind:'system'}` schedule fires. */
export type HeartbeatJob = 'infra' | 'reconcile' | 'digest-morning' | 'digest-evening';

export type DigestVariant = 'morning' | 'evening';

/** Real window-scoped counts folded from durable rows for the digest (finding #5). */
export interface DigestCounts {
  runsOk: number;
  runsFailed: number;
  prsOpened: number;
  attentionRaised: number;
  attentionResolved: number;
  sessionsCompleted: number;
  sessionsNeedsYou: number;
  runsToday: number;
  cap: number;
}

/** One infra self-check result the heartbeat folds into the attention queue. */
export interface InfraCheckResult {
  /** True = healthy (auto-resolve any prior item); false = raise an item. */
  ok: boolean;
  /** Attention kind, e.g. 'credential-expiring' | 'zombie-session'. */
  kind: string;
  /** subjectId keying the attention item, e.g. 'forge:github' | 'session:<id>'. */
  subjectId: string;
  projectPath: string | null;
  title: string;
  payload?: Record<string, unknown> | null;
}

/** The pure digest shape (data-first, since-last deltas + current snapshots). */
export interface Digest {
  variant: DigestVariant;
  windowFrom: number;
  windowTo: number;
  loops: { runsOk: number; runsFailed: number; prsOpened: number };
  attention: { raised: number; resolved: number; openTopCount: number };
  sessions: { completed: number; needsYou: number };
  budget: { runsToday: number; cap: number };
  highlights: DigestHighlight[];
  projectLines: DigestProjectLine[];
}

export interface DigestHighlight {
  id: string;
  ts: number;
  kind: string;
  title: string;
  projectPath: string | null;
  provider: string | null;
  sessionId?: string;
  taskId?: string;
  loopId?: string;
  attentionId?: string;
  prUrl?: string;
  outcome?: string;
  verify?: string;
  severity?: number;
}

export interface DigestProjectLine {
  projectPath: string | null;
  title: string;
}

/** Push payload for the digest (short, phone-first). */
export interface DigestPushContent {
  title: string;
  body: string;
  data: { slotKey: string };
}

export interface DigestRunRow {
  slot_key: string;
  variant: string;
  sent_at: number;
  window_from: number;
  window_to: number;
  summary_json: string;
}

export interface DigestRunDto {
  slotKey: string;
  variant: DigestVariant;
  sentAt: number;
  windowFrom: number;
  windowTo: number;
  digest: Digest;
}
