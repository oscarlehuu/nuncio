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
const BOOTSTRAP_RELAY_FALLBACK_MS = 1_000;

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

/**
 * `base` targets a specific machine's API (origin-absolute, hub mode); the
 * default empty string keeps page-relative behavior (rewritten by the page's
 * own hub base where applicable).
 *
 * `tail` bounds the initial load to the last N events; earlier history stays
 * on the server until `loadEarlier` pages it in (seq 1 is always the start,
 * so `hasEarlier` is simply "oldest loaded seq > 1").
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

  const flushPendingEvents = useCallback(() => {
    scheduledFlushRef.current = null;
    const pending = pendingEventsRef.current;
    if (pending.length === 0) return;
    pendingEventsRef.current = [];
    updateEvents((prev) => mergeEvents(prev, pending));
  }, [updateEvents]);

  const scheduleEventFlush = useCallback(() => {
    if (scheduledFlushRef.current) return;
    if (typeof requestAnimationFrame === 'function') {
      const id = requestAnimationFrame(flushPendingEvents);
      scheduledFlushRef.current = { id, cancel: cancelAnimationFrame };
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
    updateEvents((current) => mergeEvents(mergeEvents(current, pending), initial));
    const fetchedSeq = initial.reduce((max, e) => Math.max(max, e.seq), 0);
    sinceRef.current = Math.max(sinceRef.current, fetchedSeq);
    connect(generation);
  }, [connect, fetchInitial, isCurrent, updateEvents, cancelPendingEventFlush]);

  /** Page one window of history in before the oldest loaded event. */
  const loadEarlier = useCallback(async () => {
    const id = sessionIdRef.current;
    const generation = generationRef.current;
    if (!id || loadingEarlierRef.current) return;
    const oldestSeq = eventsRef.current[0]?.seq ?? 0;
    if (oldestSeq <= 1) return;
    loadingEarlierRef.current = true;
    try {
      const earlier = await fetchEvents(id, 0, baseRef.current, { before: oldestSeq });
      if (!isCurrent(id, generation)) return;
      updateEvents((prev) => mergeEvents(prev, earlier));
    } finally {
      loadingEarlierRef.current = false;
    }
  }, [isCurrent, updateEvents]);

  useEffect(() => {
    const generation = ++generationRef.current;
    const request = ++requestRef.current;
    cancelPendingEventFlush();
    replaceEvents([]);
    sinceRef.current = 0;
    loadingEarlierRef.current = false;

    if (!sessionId) {
      return () => {
        if (generationRef.current === generation) generationRef.current += 1;
      };
    }

    const ensureConnected = () => {
      if (isCurrent(sessionId, generation) && !subscriptionRef.current) connect(generation);
    };
    const fallbackTimer = window.setTimeout(ensureConnected, BOOTSTRAP_RELAY_FALLBACK_MS);

    void fetchInitial(sessionId)
      .then((initial) => {
        if (!isCurrent(sessionId, generation) || requestRef.current !== request) return;
        updateEvents((current) => mergeEvents(current, initial));
        const fetchedSeq = initial.reduce((max, e) => Math.max(max, e.seq), 0);
        sinceRef.current = Math.max(sinceRef.current, fetchedSeq);
      })
      .catch(() => {
        // REST is only a bootstrap optimization. The relay still subscribes
        // from seq 0 so durable replay can recover a transient fetch failure.
      })
      .finally(() => {
        window.clearTimeout(fallbackTimer);
        ensureConnected();
      });

    const onVisibility = () => {
      if (document.visibilityState !== 'visible') return;
      if (subscriptionRef.current) subscriptionRef.current.resync();
      else connect();
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      if (generationRef.current === generation) generationRef.current += 1;
      window.clearTimeout(fallbackTimer);
      document.removeEventListener('visibilitychange', onVisibility);
      subscriptionRef.current?.close();
      subscriptionRef.current = null;
      cancelPendingEventFlush();
    };
  }, [sessionId, base, connect, fetchInitial, isCurrent, replaceEvents, updateEvents, cancelPendingEventFlush]);

  const hasEarlier = (events[0]?.seq ?? 0) > 1;

  return { events, refetch, loadEarlier, hasEarlier };
}
