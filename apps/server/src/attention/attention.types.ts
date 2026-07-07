/**
 * Attention queue (rung 3, sub-phase A). ONE ranked queue of everything needing
 * the founder. Signals are COLLECTED from existing rungs-1/2 sources (no new
 * session event types — ADR-007 additive); items are durable + deduped (one open
 * item per condition) + reconciled on restart.
 */

/** The condition families the queue tracks. Unknown/legacy kinds rank last, never throw. */
export type AttentionKind =
  | 'permission'
  | 'credential-expiring'
  | 'verify-dead'
  | 'tripped-breaker'
  | 'zombie-session'
  | 'pr-review'
  | 'anomaly';

export type AttentionStatus = 'open' | 'resolved';

/**
 * Static severity buckets (decision #1 — NOT a learned score). Higher = more
 * urgent. An unknown kind maps to 0 (ranks last). The rung-3 heartbeat (sub-phase
 * B) adds the two infra kinds: an expiring/invalid credential is near the top (a
 * dead cred at 3am kills the whole night's queue); a zombie session sits mid.
 */
export const SEVERITY_BY_KIND: Readonly<Record<AttentionKind, number>> = {
  permission: 7,
  'credential-expiring': 6,
  'verify-dead': 5,
  'tripped-breaker': 4,
  'zombie-session': 3,
  'pr-review': 2,
  anomaly: 1,
};

export const UNKNOWN_SEVERITY = 0;

/** A durable attention item — one row per open (kind, subjectId) condition. */
export interface AttentionItemDto {
  id: string;
  kind: string;
  /** The thing needing attention: sessionId | loopId | prKey | … */
  subjectId: string;
  /** For project-importance ranking + fleet grouping. Null when project-less. */
  projectPath: string | null;
  severity: number;
  title: string;
  /** Kind-specific detail (requestId, PR url, verify-tail pointer, …), or null. */
  payload: Record<string, unknown> | null;
  status: AttentionStatus;
  /** Ack = "seen"; mutes the badge; does NOT resolve. Null until acked. */
  acknowledgedAt: number | null;
  /**
   * A manual resolve of a still-live condition sets this so a periodic sweep does
   * not re-raise the founder's override. The sweep clears it once the underlying
   * condition is observed CLEAR, so a genuine re-trip yields a fresh item.
   */
  suppressReraise: boolean;
  createdAt: number;
  updatedAt: number;
  /** Set when status → resolved (auto or manual). */
  resolvedAt: number | null;
}

/** A raised signal — what a collector calls `AttentionService.raise` with. */
export interface RaiseSignal {
  kind: string;
  subjectId: string;
  projectPath?: string | null;
  title: string;
  payload?: Record<string, unknown> | null;
}

/** Badge counts for the phone. `unacked` (open ∧ not acknowledged) is the badge source. */
export interface AttentionCounts {
  total: number;
  unacked: number;
  bySeverity: Record<string, number>;
}

export interface AttentionItemRow {
  id: string;
  kind: string;
  subject_id: string;
  project_path: string | null;
  severity: number;
  title: string;
  payload_json: string | null;
  status: string;
  acknowledged_at: number | null;
  suppress_reraise: number;
  created_at: number;
  updated_at: number;
  resolved_at: number | null;
}
