import type { AttentionItemDto } from '../attention.types';

/**
 * Fleet home (rung 3, sub-phase C) — the founder's cockpit landing surface. One
 * row per project, derived on demand (pure fold, no materialized store) from the
 * durable rows rungs 1-3 already keep. Phone-first: ready-to-render.
 */

export type FleetHealth = 'green' | 'yellow' | 'red';

/**
 * The high-severity threshold: an OPEN attention item whose kind sits at or above
 * this bucket makes a project RED (needs you). permission(7)/credential-expiring(6)/
 * verify-dead(5)/tripped-breaker(4) → red; zombie(3)/pr-review(2)/anomaly(1) → yellow.
 */
export const FLEET_HIGH_THRESHOLD = 4;

export interface FleetCounts {
  openAttention: number;
  runningSessions: number;
  activeLoops: number;
  openPRs: number;
}

/** The pure-fold health result for one project. */
export interface FleetHealthResult {
  health: FleetHealth;
  reasons: string[];
  counts: FleetCounts;
}

/** Raw per-project inputs the health/row fold consumes (all from existing rows). */
export interface FleetProjectInput {
  path: string;
  name: string;
  weight: number;
  openItems: AttentionItemDto[];
  runningSessions: number;
  activeLoops: number;
  openPRs: number;
  /** 'green'|'red'|'none' — the most recent settled loop-run verify for the project. */
  lastVerify: 'green' | 'red' | 'none';
  lastActivityAt: number | null;
}

/** A UI-ready fleet row (phone-first). */
export interface FleetRow {
  path: string;
  name: string;
  weight: number;
  health: FleetHealth;
  reasons: string[];
  topItem: AttentionItemDto | null;
  counts: FleetCounts;
  lastActivityAt: number | null;
}
