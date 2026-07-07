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
  // TODO: implement stable total-order ranking (rung-3 sub-phase A).
  throw new Error('TODO: rankAttentionItems not implemented');
  void items;
  void projectWeights;
}
