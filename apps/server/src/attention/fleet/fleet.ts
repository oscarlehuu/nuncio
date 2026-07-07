import type { AttentionItemDto } from '../attention.types';
import type { FleetHealthResult, FleetProjectInput, FleetRow } from './fleet.types';

/**
 * Fold a project's open signals into its health color + reasons + counts (rung 3
 * sub-phase C). Pure, table-testable, NO scores:
 *   red    — any OPEN attention item in a HIGH bucket (severity >= FLEET_HIGH_THRESHOLD)
 *   yellow — any OPEN attention item (but none high)
 *   green  — nothing open
 * `reasons` names what drove the color so the phone row is self-explaining.
 *
 * RED until implemented — neutral TODO so the health-table tests don't false-green.
 */
export function foldHealth(input: FleetProjectInput): FleetHealthResult {
  throw new Error('TODO: foldHealth not implemented');
  void input;
}

/** The highest-ranked OPEN attention item for a project, or null (reuses the ranker). */
export function topAttentionItem(
  openItems: AttentionItemDto[],
  projectWeights: Record<string, number> = {},
): AttentionItemDto | null {
  throw new Error('TODO: topAttentionItem not implemented');
  void openItems;
  void projectWeights;
}

/**
 * Total, deterministic fleet order for the phone list:
 *   red first (health rank) → weight DESC → lastActivityAt DESC → path ASC.
 * Pure. RED until implemented.
 */
export function orderFleet(rows: FleetRow[]): FleetRow[] {
  throw new Error('TODO: orderFleet not implemented');
  void rows;
}
