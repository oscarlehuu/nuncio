import type { PlanItem } from '@nuncio/core/plan.types';
import { planProgress } from '@nuncio/core/plan.types';

/**
 * Compact "n/m steps" label for a session-list row, or null when there is no
 * plan to show. Kept pure so the list row stays a dumb renderer.
 */
export function planStepsLabel(items: PlanItem[] | undefined): string | null {
  if (!items || items.length === 0) return null;
  const { done, total } = planProgress(items);
  return `${done}/${total} steps`;
}
