import { severityForKind } from '../attention-ranking';
import { rankAttentionItems } from '../attention-ranking';
import type { AttentionItemDto } from '../attention.types';
import {
  FLEET_HIGH_THRESHOLD,
  type FleetHealth,
  type FleetHealthResult,
  type FleetProjectInput,
  type FleetRow,
} from './fleet.types';

/** Health → sort rank (red first). */
const HEALTH_RANK: Readonly<Record<FleetHealth, number>> = { red: 0, yellow: 1, green: 2 };

/**
 * Fold a project's open signals into its health color + reasons + counts (rung 3
 * sub-phase C). Pure, table-testable, NO scores:
 *   red    — any OPEN attention item in a HIGH bucket (severity >= FLEET_HIGH_THRESHOLD)
 *   yellow — any OPEN attention item (but none high)
 *   green  — nothing open
 * `reasons` names what drove the color so the phone row is self-explaining.
 */
export function foldHealth(input: FleetProjectInput): FleetHealthResult {
  const counts = {
    openAttention: input.openItems.length,
    runningSessions: input.runningSessions,
    activeLoops: input.activeLoops,
    openPRs: input.openPRs,
  };
  const high = input.openItems.filter((i) => severityForKind(i.kind) >= FLEET_HIGH_THRESHOLD);

  if (high.length > 0) {
    return { health: 'red', reasons: [`${high.length} need you`], counts };
  }
  if (input.openItems.length > 0) {
    return { health: 'yellow', reasons: yellowReasons(input), counts };
  }
  return { health: 'green', reasons: [], counts };
}

/** Human "what to look at" lines for a yellow project (PRs / anomalies / other). */
function yellowReasons(input: FleetProjectInput): string[] {
  const reasons: string[] = [];
  const prs = input.openItems.filter((i) => i.kind === 'pr-review').length;
  const anomalies = input.openItems.filter(
    (i) => i.kind === 'anomaly' || i.kind === 'session-empty-diff' || i.kind === 'loop-failing',
  ).length;
  const other = input.openItems.length - prs - anomalies;
  if (prs > 0) reasons.push(`${prs} PR${prs === 1 ? '' : 's'} awaiting review`);
  if (anomalies > 0) reasons.push(`${anomalies} anomal${anomalies === 1 ? 'y' : 'ies'}`);
  if (other > 0) reasons.push(`${other} to review`);
  return reasons.length > 0 ? reasons : [`${input.openItems.length} to review`];
}

/** The highest-ranked OPEN attention item for a project, or null (reuses the ranker). */
export function topAttentionItem(
  openItems: AttentionItemDto[],
  projectWeights: Record<string, number> = {},
): AttentionItemDto | null {
  if (openItems.length === 0) return null;
  return rankAttentionItems(openItems, projectWeights)[0] ?? null;
}

/**
 * Total, deterministic fleet order for the phone list:
 *   red first (health rank) → weight DESC → lastActivityAt DESC → path ASC.
 */
export function orderFleet(rows: FleetRow[]): FleetRow[] {
  return [...rows].sort((a, b) => {
    const ha = HEALTH_RANK[a.health];
    const hb = HEALTH_RANK[b.health];
    if (ha !== hb) return ha - hb; // red first
    if (a.weight !== b.weight) return b.weight - a.weight; // higher importance first
    const la = a.lastActivityAt ?? -Infinity;
    const lb = b.lastActivityAt ?? -Infinity;
    if (la !== lb) return lb - la; // more recent first
    return a.path < b.path ? -1 : a.path > b.path ? 1 : 0; // stable path tiebreak
  });
}
