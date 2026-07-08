import { apiFetch } from './http';

/**
 * Attention queue client (rung 3) — ONE ranked queue of everything needing the
 * founder. The server ranks (severity → project weight → age) and returns items
 * in order, so the UI renders as-is and never re-sorts. Kinds are open strings:
 * an unknown/future kind ranks last server-side and must never break the client.
 */

/** Known condition families. The client treats `kind` as a string and tolerates others. */
export type AttentionKind =
  | 'permission'
  | 'verify-dead'
  | 'tripped-breaker'
  | 'pr-review'
  | 'anomaly';

export type AttentionStatus = 'open' | 'resolved';

/** A durable attention item — one row per open (kind, subjectId) condition. */
export interface AttentionItemDto {
  id: string;
  /** Open string — known values in {@link AttentionKind}, but tolerate unknowns. */
  kind: string;
  /** The thing needing attention: sessionId | loopId | prKey | … */
  subjectId: string;
  projectPath: string | null;
  /** Static severity bucket (higher = more urgent); unknown kinds are 0. */
  severity: number;
  title: string;
  /** Kind-specific detail (requestId, PR url/webUrl, verify-tail pointer, …), or null. */
  payload: Record<string, unknown> | null;
  status: AttentionStatus;
  /** Ack = "seen"; mutes the badge; does NOT resolve. Null until acked. */
  acknowledgedAt: number | null;
  createdAt: number;
  updatedAt: number;
  resolvedAt: number | null;
}

/** Badge counts for the phone. `unacked` (open ∧ not acknowledged) is the badge source. */
export interface AttentionCounts {
  total: number;
  unacked: number;
  bySeverity: Record<string, number>;
}

export interface AttentionList {
  items: AttentionItemDto[];
  counts: AttentionCounts;
}

export interface DispatcherApprovalResult {
  proposalId: string;
  taskIds: string[];
}

const EMPTY_COUNTS: AttentionCounts = { total: 0, unacked: 0, bySeverity: {} };

/** The ranked open queue + counts. Items arrive pre-ranked — render in order. */
export async function fetchAttention(): Promise<AttentionList> {
  const res = await apiFetch('/api/attention');
  if (!res.ok) throw new Error('Failed to load attention queue');
  const data = (await res.json()) as Partial<AttentionList>;
  return { items: data.items ?? [], counts: data.counts ?? EMPTY_COUNTS };
}

/** Badge counts alone — the cheap poll for the sidebar badge. */
export async function fetchAttentionCounts(): Promise<AttentionCounts> {
  const res = await apiFetch('/api/attention/counts');
  if (!res.ok) throw new Error('Failed to load attention counts');
  const data = (await res.json()) as Partial<AttentionCounts>;
  return { total: data.total ?? 0, unacked: data.unacked ?? 0, bySeverity: data.bySeverity ?? {} };
}

/** Ack an item ("seen"): mutes the badge, the item stays open until its condition clears. */
export async function ackAttentionItem(id: string): Promise<AttentionItemDto> {
  const res = await apiFetch(`/api/attention/${encodeURIComponent(id)}/ack`, { method: 'POST' });
  if (!res.ok) throw new Error('Failed to acknowledge item');
  return res.json();
}

/** Manually resolve an item (founder override) — terminal. */
export async function resolveAttentionItem(id: string): Promise<AttentionItemDto> {
  const res = await apiFetch(`/api/attention/${encodeURIComponent(id)}/resolve`, { method: 'POST' });
  if (!res.ok) throw new Error('Failed to resolve item');
  return res.json();
}

/** Approve a dispatcher proposal attention item; the server resolves the item after queueing. */
export async function approveDispatcherProposal(id: string): Promise<DispatcherApprovalResult> {
  const res = await apiFetch(`/api/dispatcher/proposals/${encodeURIComponent(id)}/approve`, { method: 'POST' });
  if (!res.ok) throw new Error('Failed to approve dispatcher proposal');
  const data = (await res.json()) as Partial<DispatcherApprovalResult>;
  return { proposalId: data.proposalId ?? id, taskIds: Array.isArray(data.taskIds) ? data.taskIds : [] };
}

// ── Heartbeat digest (rung 3 sub-phase B) — the morning/evening briefing ────

export type DigestVariant = 'morning' | 'evening';

/** The digest body — since-last deltas + current snapshots. Counts, not lists. */
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

/** A sent digest slot — `slotKey = '<YYYY-MM-DD>:<morning|evening>'`. */
export interface DigestRunDto {
  slotKey: string;
  variant: DigestVariant;
  sentAt: number;
  windowFrom: number;
  windowTo: number;
  digest: Digest;
}

/** Fill any missing section so a partial/legacy payload never breaks the view. */
const ZERO_SECTIONS = {
  loops: { runsOk: 0, runsFailed: 0, prsOpened: 0 },
  attention: { raised: 0, resolved: 0, openTopCount: 0 },
  sessions: { completed: 0, needsYou: 0 },
  budget: { runsToday: 0, cap: 0 },
  highlights: [] as DigestHighlight[],
  projectLines: [] as DigestProjectLine[],
};

function normalizeDigest(raw: Partial<Digest> & { variant?: DigestVariant }): Digest {
  return {
    variant: raw.variant === 'evening' ? 'evening' : 'morning',
    windowFrom: raw.windowFrom ?? 0,
    windowTo: raw.windowTo ?? 0,
    loops: { ...ZERO_SECTIONS.loops, ...raw.loops },
    attention: { ...ZERO_SECTIONS.attention, ...raw.attention },
    sessions: { ...ZERO_SECTIONS.sessions, ...raw.sessions },
    budget: { ...ZERO_SECTIONS.budget, ...raw.budget },
    highlights: Array.isArray(raw.highlights) ? raw.highlights : ZERO_SECTIONS.highlights,
    projectLines: Array.isArray(raw.projectLines) ? raw.projectLines : ZERO_SECTIONS.projectLines,
  };
}

/**
 * The in-app digest. `slot` defaults to 'latest' (the most-recent sent briefing);
 * pass a specific `<YYYY-MM-DD>:<variant>` key for a past slot. Returns null when no
 * digest has been built yet (a valid "no briefing yet" state). Partial sections are
 * filled with zeros so a legacy/partial payload renders instead of crashing.
 */
export async function fetchDigest(slot = 'latest'): Promise<DigestRunDto | null> {
  const res = await apiFetch(`/api/heartbeat/digest?slot=${encodeURIComponent(slot)}`);
  if (!res.ok) throw new Error('Failed to load digest');
  const data = (await res.json()) as DigestRunDto | null;
  if (!data || !data.digest) return null;
  return { ...data, digest: normalizeDigest(data.digest) };
}
