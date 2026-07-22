import type { SessionEvent } from './api';

export const DEFAULT_SESSION_DETAIL_EVENT_TAIL = 1000;
export const DEFAULT_SESSION_EVENT_BACKFILL_LIMIT = 200;

/** Merge canonical event windows by seq while keeping the live append path cheap. */
export function mergeSessionEvents(
  previous: SessionEvent[],
  incoming: SessionEvent[],
): SessionEvent[] {
  if (incoming.length === 0) return previous;

  let lastSeq = previous.at(-1)?.seq ?? Number.NEGATIVE_INFINITY;
  let canAppend = true;
  for (const event of incoming) {
    if (event.seq <= lastSeq) {
      canAppend = false;
      break;
    }
    lastSeq = event.seq;
  }
  if (canAppend) return [...previous, ...incoming];

  const seen = new Set(previous.map((event) => event.seq));
  const fresh: SessionEvent[] = [];
  for (const event of incoming) {
    if (seen.has(event.seq)) continue;
    seen.add(event.seq);
    fresh.push(event);
  }
  if (fresh.length === 0) return previous;

  return [...previous, ...fresh].sort((left, right) => left.seq - right.seq);
}

function retentionLimit(tail: number | undefined): number | null {
  if (!Number.isFinite(tail) || (tail ?? 0) <= 0) return null;
  const limit = Math.floor(tail!);
  return limit > 0 ? limit : null;
}

export function highestSessionEventSeq(events: SessionEvent[]): number {
  return events.at(-1)?.seq ?? 0;
}

/**
 * Keep an unexpanded transcript to its live tail. Once history is explicitly
 * loaded, retain that protected prefix and roll only the newer suffix.
 */
export function retainSessionEventWindow(
  events: SessionEvent[],
  tail: number | undefined,
  protectedThrough = 0,
): SessionEvent[] {
  const limit = retentionLimit(tail);
  if (limit === null || events.length <= limit) return events;
  if (protectedThrough <= 0) return events.slice(-limit);

  const firstRolling = events.findIndex((event) => event.seq > protectedThrough);
  if (firstRolling < 0 || events.length - firstRolling <= limit) return events;
  return [...events.slice(0, firstRolling), ...events.slice(-limit)];
}

/** Fill an internal retained gap before paging below the oldest loaded event. */
export function nextSessionEventBackfillBefore(events: SessionEvent[]): number | null {
  if (events.length === 0) return null;
  for (let index = 1; index < events.length; index += 1) {
    if (events[index]!.seq > events[index - 1]!.seq + 1) return events[index]!.seq;
  }
  return events[0]!.seq > 1 ? events[0]!.seq : null;
}

export function hasEarlierSessionEvents(events: SessionEvent[]): boolean {
  return nextSessionEventBackfillBefore(events) !== null;
}
