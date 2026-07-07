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
