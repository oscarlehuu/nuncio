import { useCallback, useEffect, useRef, useState } from 'react';
import type { SessionEvent } from './api';
import { fetchEvents } from './api';
import { withBase } from './api-base';
import {
  subscribeSessionEvents,
  type SessionSubscription,
} from '@nuncio/core/session-relay-client';

/** Initial window for the full session view; older history pages in on demand. */
export const DETAIL_EVENT_TAIL = 1000;

type ScheduledFlush = {
  id: number;
  cancel: (id: number) => void;
};

/** ws(s):// URL of the session relay (page hub base, or an explicit machine base). */
export function sessionRelayUrl(base = ''): string {
  const path = '/api/sessions/ws';
  const prefixed = base ? withBase(path, base) : withBase(path);
  const url = new URL(prefixed, window.location.origin);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

function mergeEvents(prev: SessionEvent[], incoming: SessionEvent[]): SessionEvent[] {
  if (incoming.length === 0) return prev;
  // Live relay events arrive in strictly ascending seq order past the loaded
  // tail; appending directly keeps per-frame cost independent of session length.
  let ascending = true;
  let lastSeq = prev.length > 0 ? prev[prev.length - 1].seq : Number.NEGATIVE_INFINITY;
  for (const event of incoming) {
    if (event.seq <= lastSeq) {
      ascending = false;
      break;
    }
    lastSeq = event.seq;
  }
  if (ascending) return [...prev, ...incoming];
  const seen = new Set(prev.map((e) => e.seq));
  const fresh: SessionEvent[] = [];
  for (const event of incoming) {
    if (seen.has(event.seq)) continue;
    seen.add(event.seq);
    fresh.push(event);
  }
  if (fresh.length === 0) return prev;
  return [...prev, ...fresh].sort((a, b) => a.seq - b.seq);
}

function retentionLimit(tail: number | undefined): number | null {
  if (!Number.isFinite(tail) || (tail ?? 0) <= 0) return null;
  const limit = Math.floor(tail!);
  return limit > 0 ? limit : null;
}

function highestSeq(events: SessionEvent[]): number {
  return events.length > 0 ? events[events.length - 1].seq : 0;
}

function retainEventWindow(
  events: SessionEvent[],
  tail: number | undefined,
  protectedThrough: number,
): SessionEvent[] {
  const limit = retentionLimit(tail);
  if (limit === null || events.length <= limit) return events;
  if (protectedThrough <= 0) return events.slice(-limit);

  const firstRolling = events.findIndex((event) => event.seq > protectedThrough);
  if (firstRolling < 0 || events.length - firstRolling <= limit) return events;
  return [...events.slice(0, firstRolling), ...events.slice(-limit)];
}

function nextBackfillBefore(events: SessionEvent[]): number | null {
  if (events.length === 0) return null;
  for (let index = 1; index < events.length; index += 1) {
    if (events[index].seq > events[index - 1].seq + 1) return events[index].seq;
  }
  return events[0].seq > 1 ? events[0].seq : null;
}

function hasMissingEarlierEvents(events: SessionEvent[]): boolean {
  if (events.length === 0) return false;
  if (events[0].seq > 1) return true;
  for (let index = 1; index < events.length; index += 1) {
    if (events[index].seq > events[index - 1].seq + 1) return true;
  }
  return false;
}

/**
 * `base` targets a specific machine's API (origin-absolute, hub mode); the
 * default empty string keeps page-relative behavior (rewritten by the page's
 * own hub base where applicable).
 *
 * `tail` bounds both the cursor-zero bootstrap and automatic live retention.
 * Explicit paging protects the rows the user chose to load; only the newer live
 * suffix keeps rolling, and `loadEarlier` fills any retained gap before paging
 * below the oldest row.
 */
export function useSessionStream(sessionId: string | null, base = '', tail?: number) {
  const [events, setEvents] = useState<SessionEvent[]>([]);
  const sinceRef = useRef(0);
  const subscriptionRef = useRef<SessionSubscription | null>(null);
  const generationRef = useRef(0);
  const requestRef = useRef(0);
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;
  const baseRef = useRef(base);
  baseRef.current = base;
  const tailRef = useRef(tail);
  tailRef.current = tail;
  const eventsRef = useRef<SessionEvent[]>([]);
  const loadingEarlierRef = useRef(false);
  const backfillRequestRef = useRef(0);
  const protectedThroughRef = useRef(0);
  const pendingProtectionThroughRef = useRef(0);
  const pendingEventsRef = useRef<SessionEvent[]>([]);
  const scheduledFlushRef = useRef<ScheduledFlush | null>(null);

  const replaceEvents = useCallback((next: SessionEvent[]) => {
    eventsRef.current = next;
    setEvents(next);
  }, []);

  const updateEvents = useCallback((updater: (prev: SessionEvent[]) => SessionEvent[]) => {
    const next = updater(eventsRef.current);
    eventsRef.current = next;
    setEvents(next);
  }, []);

  const applyRetention = useCallback((candidate: SessionEvent[]) => retainEventWindow(
    candidate,
    tailRef.current,
    Math.max(protectedThroughRef.current, pendingProtectionThroughRef.current),
  ), []);

  const flushPendingEvents = useCallback(() => {
    scheduledFlushRef.current = null;
    const pending = pendingEventsRef.current;
    if (pending.length === 0) return;
    pendingEventsRef.current = [];
    updateEvents((prev) => applyRetention(mergeEvents(prev, pending)));
  }, [applyRetention, updateEvents]);

  const scheduleEventFlush = useCallback(() => {
    if (scheduledFlushRef.current) return;
    if (typeof requestAnimationFrame === 'function') {
      const id = requestAnimationFrame(flushPendingEvents);
      // Wrap the canceller so it always runs with the window receiver. A bare
      // `cancelAnimationFrame` reference, stored here and later invoked as
      // `scheduled.cancel(id)`, would run with `this` bound to the ScheduledFlush
      // object and throw "Illegal invocation" — crashing the app to a blank
      // screen when the flush is cancelled on unmount/navigation.
      scheduledFlushRef.current = { id, cancel: (handle) => window.cancelAnimationFrame(handle) };
      return;
    }
    const id = window.setTimeout(() => flushPendingEvents(), 16);
    scheduledFlushRef.current = { id, cancel: (handle) => window.clearTimeout(handle) };
  }, [flushPendingEvents]);

  const cancelPendingEventFlush = useCallback(() => {
    const scheduled = scheduledFlushRef.current;
    if (scheduled) {
      scheduled.cancel(scheduled.id);
      scheduledFlushRef.current = null;
    }
    pendingEventsRef.current = [];
  }, []);

  const onEvent = useCallback((event: SessionEvent) => {
    sinceRef.current = Math.max(sinceRef.current, event.seq);
    pendingEventsRef.current.push(event);
    scheduleEventFlush();
  }, [scheduleEventFlush]);

  const fetchInitial = useCallback((id: string) => {
    const depth = tailRef.current;
    return depth !== undefined
      ? fetchEvents(id, 0, baseRef.current, { tail: depth })
      : fetchEvents(id, 0, baseRef.current);
  }, []);

  const isCurrent = useCallback((id: string, generation: number) => (
    generationRef.current === generation && sessionIdRef.current === id
  ), []);

  const connect = useCallback((generation = generationRef.current) => {
    const activeSessionId = sessionIdRef.current;
    if (!activeSessionId || !isCurrent(activeSessionId, generation)) return;
    subscriptionRef.current?.close();
    subscriptionRef.current = subscribeSessionEvents({
      url: sessionRelayUrl(baseRef.current),
      sessionId: activeSessionId,
      since: sinceRef.current,
      tail: tailRef.current,
      onEvent,
    });
  }, [isCurrent, onEvent]);

  const refetch = useCallback(async () => {
    const id = sessionIdRef.current;
    const generation = generationRef.current;
    const request = ++requestRef.current;
    if (!id) return;
    const initial = await fetchInitial(id);
    if (!isCurrent(id, generation) || requestRef.current !== request) return;
    const pending = pendingEventsRef.current;
    cancelPendingEventFlush();
    updateEvents((current) => applyRetention(mergeEvents(mergeEvents(current, pending), initial)));
    const fetchedSeq = initial.reduce((max, e) => Math.max(max, e.seq), 0);
    sinceRef.current = Math.max(sinceRef.current, fetchedSeq);
    connect(generation);
  }, [applyRetention, connect, fetchInitial, isCurrent, updateEvents, cancelPendingEventFlush]);

  /** Fill the earliest retained gap, then page below the oldest loaded event. */
  const loadEarlier = useCallback(async () => {
    const id = sessionIdRef.current;
    const generation = generationRef.current;
    if (!id || loadingEarlierRef.current) return;
    const before = nextBackfillBefore(eventsRef.current);
    if (before === null) return;

    const request = ++backfillRequestRef.current;
    loadingEarlierRef.current = true;
    // While the request is pending, keep the rows the user expanded from. The
    // protection commits only after a successful response; failure rolls back
    // to the prior semantic window.
    pendingProtectionThroughRef.current = Math.max(
      protectedThroughRef.current,
      highestSeq(eventsRef.current),
    );
    let committed = false;
    try {
      const earlier = await fetchEvents(id, 0, baseRef.current, { before });
      if (!isCurrent(id, generation) || backfillRequestRef.current !== request) return;
      const pending = pendingEventsRef.current;
      cancelPendingEventFlush();
      updateEvents((prev) => {
        const merged = mergeEvents(mergeEvents(prev, pending), earlier);
        protectedThroughRef.current = Math.max(
          protectedThroughRef.current,
          highestSeq(merged),
        );
        pendingProtectionThroughRef.current = 0;
        return applyRetention(merged);
      });
      committed = true;
    } finally {
      if (backfillRequestRef.current === request) {
        loadingEarlierRef.current = false;
        if (!committed) {
          pendingProtectionThroughRef.current = 0;
          updateEvents((prev) => applyRetention(prev));
        }
      }
    }
  }, [applyRetention, cancelPendingEventFlush, isCurrent, updateEvents]);

  useEffect(() => {
    const generation = ++generationRef.current;
    const request = ++requestRef.current;
    cancelPendingEventFlush();
    replaceEvents([]);
    sinceRef.current = 0;
    loadingEarlierRef.current = false;
    backfillRequestRef.current += 1;
    protectedThroughRef.current = 0;
    pendingProtectionThroughRef.current = 0;

    if (!sessionId) {
      return () => {
        if (generationRef.current === generation) generationRef.current += 1;
      };
    }

    const ensureConnected = () => {
      if (isCurrent(sessionId, generation) && !subscriptionRef.current) connect(generation);
    };

    void fetchInitial(sessionId)
      .then((initial) => {
        if (!isCurrent(sessionId, generation) || requestRef.current !== request) return;
        updateEvents((current) => applyRetention(mergeEvents(current, initial)));
        const fetchedSeq = initial.reduce((max, e) => Math.max(max, e.seq), 0);
        sinceRef.current = Math.max(sinceRef.current, fetchedSeq);
      })
      .catch(() => {
        // REST is only a bootstrap optimization. The relay still subscribes
        // from seq 0 so durable replay can recover a transient fetch failure.
      })
      .finally(() => {
        ensureConnected();
      });

    // Give an already-resolved bootstrap one microtask to seed the cursor, but
    // never let real REST/network latency delay the live durable relay.
    queueMicrotask(ensureConnected);

    const onVisibility = () => {
      if (document.visibilityState !== 'visible') return;
      if (subscriptionRef.current) subscriptionRef.current.resync();
      else connect();
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      if (generationRef.current === generation) generationRef.current += 1;
      document.removeEventListener('visibilitychange', onVisibility);
      subscriptionRef.current?.close();
      subscriptionRef.current = null;
      cancelPendingEventFlush();
    };
  }, [
    sessionId,
    base,
    applyRetention,
    connect,
    fetchInitial,
    isCurrent,
    replaceEvents,
    updateEvents,
    cancelPendingEventFlush,
  ]);

  const hasEarlier = hasMissingEarlierEvents(events);

  return { events, refetch, loadEarlier, hasEarlier };
}
