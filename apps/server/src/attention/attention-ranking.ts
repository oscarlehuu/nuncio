import { SEVERITY_BY_KIND, UNKNOWN_SEVERITY, type AttentionItemDto, type AttentionKind } from './attention.types';

/**
 * Severity bucket for a kind (decision #1 — static). An unknown/legacy kind maps
 * to {@link UNKNOWN_SEVERITY} (0) so it ranks LAST and never throws.
 */
export function severityForKind(kind: string): number {
  return SEVERITY_BY_KIND[kind as AttentionKind] ?? UNKNOWN_SEVERITY;
}

/**
 * Total, deterministic order for the phone list:
 *   severity DESC → project importance weight DESC → createdAt ASC → id ASC.
 * Pure — `projectWeights` maps projectPath → weight (default 1 when absent).
 * The `id` final tiebreak makes the order stable across identical requests.
 */
export function rankAttentionItems(
  items: AttentionItemDto[],
  projectWeights: Record<string, number> = {},
): AttentionItemDto[] {
  const weightOf = (item: AttentionItemDto): number =>
    item.projectPath ? projectWeights[item.projectPath] ?? 1 : 1;

  // Copy before sort — never mutate the caller's array order.
  return [...items].sort((a, b) => {
    if (a.severity !== b.severity) return b.severity - a.severity; // severity DESC
    const wa = weightOf(a);
    const wb = weightOf(b);
    if (wa !== wb) return wb - wa; // project importance weight DESC
    if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt; // oldest first
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; // stable id tiebreak
  });
}
