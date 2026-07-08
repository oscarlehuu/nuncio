import { apiFetch } from './http';
import type { AttentionItemDto } from './attention-api';

/**
 * Fleet data client. One row per project, ordered by the server (red first →
 * weight → activity), so future project surfaces can render in order and never
 * re-sort. Rows are derived on demand server-side; the client tolerates a
 * partial row (missing counts/reasons) so a legacy shape still renders.
 */

export type FleetHealth = 'green' | 'yellow' | 'red';

export interface FleetCounts {
  openAttention: number;
  runningSessions: number;
  activeLoops: number;
  openPRs: number;
}

export interface FleetRow {
  path: string;
  name: string;
  weight: number;
  health: FleetHealth;
  /** Self-explaining lines that drove the color (e.g. "1 need you", "2 PRs awaiting review"). */
  reasons: string[];
  /** The highest-ranked open attention item for the project, or null. */
  topItem: AttentionItemDto | null;
  counts: FleetCounts;
  lastActivityAt: number | null;
}

const ZERO_COUNTS: FleetCounts = {
  openAttention: 0,
  runningSessions: 0,
  activeLoops: 0,
  openPRs: 0,
};

function normalizeRow(raw: Partial<FleetRow> & { path: string }): FleetRow {
  return {
    path: raw.path,
    name: raw.name ?? raw.path,
    weight: raw.weight ?? 1,
    health: raw.health ?? 'green',
    reasons: raw.reasons ?? [],
    topItem: raw.topItem ?? null,
    counts: { ...ZERO_COUNTS, ...raw.counts },
    lastActivityAt: raw.lastActivityAt ?? null,
  };
}

/** The ordered fleet (red first). Rows arrive pre-ordered — render as-is. */
export async function fetchFleet(): Promise<FleetRow[]> {
  const res = await apiFetch('/api/fleet');
  if (!res.ok) throw new Error('Failed to load the fleet');
  const data = (await res.json()) as { items?: Array<Partial<FleetRow> & { path?: string }> };
  return (data.items ?? [])
    .filter((r): r is Partial<FleetRow> & { path: string } => typeof r.path === 'string')
    .map(normalizeRow);
}
