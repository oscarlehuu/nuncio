export type PlanItemStatus = 'pending' | 'in_progress' | 'done';

export interface PlanItem {
  id: string;
  text: string;
  status: PlanItemStatus;
}

/** plan_updated carries the full list on every update — replace-all semantics. */
export interface PlanUpdatedPayload {
  items: PlanItem[];
}

const STATUSES: readonly PlanItemStatus[] = ['pending', 'in_progress', 'done'];
const MAX_ITEMS = 50;
const MAX_TEXT_LENGTH = 500;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Normalize raw tool input into plan items. Tolerates missing ids and
 * statuses so any provider's plan/todo tool output can map onto the shared
 * plan_updated event. Returns undefined when there is no usable item.
 */
export function normalizePlanItems(value: unknown): PlanItem[] | undefined {
  let raw = value;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      return undefined;
    }
  }
  if (!Array.isArray(raw)) return undefined;

  const items: PlanItem[] = [];
  for (const [index, entry] of raw.slice(0, MAX_ITEMS).entries()) {
    if (!isRecord(entry)) continue;
    const text = typeof entry.text === 'string' ? entry.text.trim().slice(0, MAX_TEXT_LENGTH) : '';
    if (!text) continue;
    const status = STATUSES.includes(entry.status as PlanItemStatus)
      ? (entry.status as PlanItemStatus)
      : 'pending';
    const id = typeof entry.id === 'string' && entry.id ? entry.id : `item-${index + 1}`;
    items.push({ id, text, status });
  }
  return items.length > 0 ? items : undefined;
}
