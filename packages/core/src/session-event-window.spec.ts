import { describe, expect, it, vi } from 'vitest';
import type { SessionEvent } from './api';
import * as coreModule from './index';

const eventWindow = coreModule as unknown as {
  DEFAULT_SESSION_DETAIL_EVENT_TAIL?: number;
  DEFAULT_SESSION_EVENT_BACKFILL_LIMIT?: number;
  mergeSessionEvents?: (previous: SessionEvent[], incoming: SessionEvent[]) => SessionEvent[];
  retainSessionEventWindow?: (
    events: SessionEvent[],
    tail: number | undefined,
    protectedThrough?: number,
  ) => SessionEvent[];
  nextSessionEventBackfillBefore?: (events: SessionEvent[]) => number | null;
  hasEarlierSessionEvents?: (events: SessionEvent[]) => boolean;
  highestSessionEventSeq?: (events: SessionEvent[]) => number;
};

const DEFAULT_SESSION_DETAIL_EVENT_TAIL = eventWindow.DEFAULT_SESSION_DETAIL_EVENT_TAIL;
const DEFAULT_SESSION_EVENT_BACKFILL_LIMIT = eventWindow.DEFAULT_SESSION_EVENT_BACKFILL_LIMIT;

function mergeSessionEvents(previous: SessionEvent[], incoming: SessionEvent[]): SessionEvent[] {
  expect(eventWindow.mergeSessionEvents).toBeTypeOf('function');
  return eventWindow.mergeSessionEvents!(previous, incoming);
}

function retainSessionEventWindow(
  events: SessionEvent[],
  tail: number | undefined,
  protectedThrough = 0,
): SessionEvent[] {
  expect(eventWindow.retainSessionEventWindow).toBeTypeOf('function');
  return eventWindow.retainSessionEventWindow!(events, tail, protectedThrough);
}

function nextSessionEventBackfillBefore(events: SessionEvent[]): number | null {
  expect(eventWindow.nextSessionEventBackfillBefore).toBeTypeOf('function');
  return eventWindow.nextSessionEventBackfillBefore!(events);
}

function hasEarlierSessionEvents(events: SessionEvent[]): boolean {
  expect(eventWindow.hasEarlierSessionEvents).toBeTypeOf('function');
  return eventWindow.hasEarlierSessionEvents!(events);
}

function highestSessionEventSeq(events: SessionEvent[]): number {
  expect(eventWindow.highestSessionEventSeq).toBeTypeOf('function');
  return eventWindow.highestSessionEventSeq!(events);
}

function event(seq: number, text = `event-${seq}`): SessionEvent {
  return { seq, type: 'assistant_message', payload: { text }, createdAt: seq };
}

describe('session event window defaults', () => {
  it('exports the shared detail tail and backfill page sizes', () => {
    expect(DEFAULT_SESSION_DETAIL_EVENT_TAIL).toBe(1000);
    expect(DEFAULT_SESSION_EVENT_BACKFILL_LIMIT).toBe(200);
  });
});

describe('mergeSessionEvents', () => {
  it('preserves the previous reference for an empty incoming batch', () => {
    const previous = [event(1), event(2)];
    expect(mergeSessionEvents(previous, [])).toBe(previous);
  });

  it('preserves the previous reference for duplicate-only reconnect batches', () => {
    const previous = [event(1), event(2), event(3)];
    const incoming = [event(3, 'duplicate-three'), event(1, 'duplicate-one')];
    expect(mergeSessionEvents(previous, incoming)).toBe(previous);
  });

  it('appends a strictly ascending fresh batch without sorting', () => {
    const previous = [event(1), event(2)];
    const incoming = [event(3), event(4)];
    const sort = vi.spyOn(Array.prototype, 'sort');

    const merged = mergeSessionEvents(previous, incoming);
    const sortCalls = sort.mock.calls.length;
    sort.mockRestore();

    expect(sortCalls).toBe(0);
    expect(merged.map((item) => item.seq)).toEqual([1, 2, 3, 4]);
    expect(merged.slice(0, 2)).toEqual(previous);
    expect(previous.map((item) => item.seq)).toEqual([1, 2]);
    expect(incoming.map((item) => item.seq)).toEqual([3, 4]);
  });

  it('deduplicates an overlapping reconnect batch and keeps existing events', () => {
    const existingTwo = event(2, 'existing-two');
    const previous = [event(1), existingTwo, event(3)];
    const merged = mergeSessionEvents(previous, [
      event(2, 'replacement-two'),
      event(3, 'duplicate-three'),
      event(4),
    ]);

    expect(merged.map((item) => item.seq)).toEqual([1, 2, 3, 4]);
    expect(merged[1]).toBe(existingTwo);
  });

  it('sorts out-of-order fresh events and deduplicates the incoming batch', () => {
    const firstFive = event(5, 'first-five');
    const merged = mergeSessionEvents(
      [event(1), event(2), event(3)],
      [event(6), firstFive, event(4), event(5, 'duplicate-five')],
    );

    expect(merged.map((item) => item.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(merged[4]).toBe(firstFive);
  });

  it('prepends a backfill page before the current tail', () => {
    const tail = [event(5), event(6)];
    const backfill = [event(3), event(4)];
    const merged = mergeSessionEvents(tail, backfill);

    expect(merged.map((item) => item.seq)).toEqual([3, 4, 5, 6]);
    expect(merged[2]).toBe(tail[0]);
  });

  it('normalizes an out-of-order first batch with duplicate seq values', () => {
    const firstTwo = event(2, 'first-two');
    const merged = mergeSessionEvents([], [firstTwo, event(1), event(2, 'duplicate-two')]);

    expect(merged.map((item) => item.seq)).toEqual([1, 2]);
    expect(merged[1]).toBe(firstTwo);
  });

  it('handles a large monotonic window through the append path', () => {
    const previous = Array.from({ length: 10_000 }, (_, index) => event(index + 1));
    const incoming = [event(10_001), event(10_002)];
    const merged = mergeSessionEvents(previous, incoming);

    expect(merged).toHaveLength(10_002);
    expect(merged[0]).toBe(previous[0]);
    expect(merged[9_999]).toBe(previous[9_999]);
    expect(merged[10_000]).toBe(incoming[0]);
    expect(merged[10_001]).toBe(incoming[1]);
  });
});

describe('retained session event windows', () => {
  it('keeps exactly the tail and drops only the oldest row one past the limit', () => {
    const exactly = [event(1), event(2), event(3)];
    expect(retainSessionEventWindow(exactly, 3)).toBe(exactly);

    const onePast = [...exactly, event(4)];
    expect(retainSessionEventWindow(onePast, 3).map((item) => item.seq)).toEqual([2, 3, 4]);
  });

  it('keeps an explicit protected prefix plus a rolling live tail', () => {
    const events = Array.from({ length: 9 }, (_, index) => event(index + 1));
    expect(retainSessionEventWindow(events, 3, 5).map((item) => item.seq)).toEqual([
      1, 2, 3, 4, 5, 7, 8, 9,
    ]);
  });

  it('leaves retention disabled for invalid or sub-one tail values', () => {
    const events = [event(1), event(2), event(3)];
    for (const tail of [undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY, 0.5]) {
      expect(retainSessionEventWindow(events, tail)).toBe(events);
    }
  });

  it('targets an internal retained gap before paging below the oldest event', () => {
    const withGap = [event(1), event(2), event(5), event(6)];
    expect(nextSessionEventBackfillBefore(withGap)).toBe(5);
    expect(hasEarlierSessionEvents(withGap)).toBe(true);

    const missingPrefix = [event(3), event(4)];
    expect(nextSessionEventBackfillBefore(missingPrefix)).toBe(3);
    expect(hasEarlierSessionEvents(missingPrefix)).toBe(true);

    const complete = [event(1), event(2)];
    expect(nextSessionEventBackfillBefore(complete)).toBeNull();
    expect(hasEarlierSessionEvents(complete)).toBe(false);
    expect(highestSessionEventSeq(complete)).toBe(2);
    expect(highestSessionEventSeq([])).toBe(0);
  });
});
