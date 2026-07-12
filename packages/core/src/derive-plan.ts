import { normalizePlanItems, type PlanItem } from './plan.types';

interface EventLike {
  type: string;
  payload?: unknown;
}

/**
 * Latest plan snapshot for a session: plan_updated carries the full list on
 * every update, so the last event wins.
 */
export function derivePlan(events: Iterable<EventLike>): PlanItem[] | undefined {
  let latest: PlanItem[] | undefined;
  for (const event of events) {
    if (event.type !== 'plan_updated') continue;
    const payload = event.payload as { items?: unknown } | undefined;
    const items = normalizePlanItems(payload?.items);
    if (items) latest = items;
  }
  return latest;
}
