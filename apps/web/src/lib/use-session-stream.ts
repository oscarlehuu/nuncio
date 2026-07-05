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
  const fresh = incoming.filter((e) => !seen.has(e.seq));
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
  const cancelledRef = useRef(false);
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;
  const baseRef = useRef(base);
  baseRef.current = base;
  const tailRef = useRef(tail);
  tailRef.current = tail;
  const eventsRef = useRef<SessionEvent[]>([]);
  const loadingEarlierRef = useRef(false);

  const replaceEvents = useCallback((next: SessionEvent[]) => {
    eventsRef.current = next;
    setEvents(next);
  }, []);

  const updateEvents = useCallback((updater: (prev: SessionEvent[]) => SessionEvent[]) => {
    const next = updater(eventsRef.current);
    eventsRef.current = next;
    setEvents(next);
  }, []);

  const onEvent = useCallback((event: SessionEvent) => {
    sinceRef.current = Math.max(sinceRef.current, event.seq);
    updateEvents((prev) => {
      const last = prev[prev.length - 1];
      if (last && event.seq > last.seq) return [...prev, event];
      if (prev.some((e) => e.seq === event.seq)) return prev;
      return [...prev, event].sort((a, b) => a.seq - b.seq);
    });
  }, [updateEvents]);

  const fetchInitial = useCallback((id: string) => {
    const depth = tailRef.current;
    return depth !== undefined
      ? fetchEvents(id, 0, baseRef.current, { tail: depth })
      : fetchEvents(id, 0, baseRef.current);
  }, []);

  const connect = useCallback(() => {
    const activeSessionId = sessionIdRef.current;
    if (!activeSessionId || cancelledRef.current) return;
    subscriptionRef.current?.close();
    subscriptionRef.current = subscribeSessionEvents({
      url: sessionRelayUrl(baseRef.current),
      sessionId: activeSessionId,
      since: sinceRef.current,
      onEvent,
    });
  }, [onEvent]);

  const refetch = useCallback(async () => {
    if (!sessionId || cancelledRef.current) return;
    const initial = await fetchInitial(sessionId);
    if (cancelledRef.current) return;
    replaceEvents(initial);
    sinceRef.current = initial.reduce((max, e) => Math.max(max, e.seq), 0);
    connect();
  }, [sessionId, connect, fetchInitial, replaceEvents]);

  /** Page one window of history in before the oldest loaded event. */
  const loadEarlier = useCallback(async () => {
    const id = sessionIdRef.current;
    if (!id || cancelledRef.current || loadingEarlierRef.current) return;
    const oldestSeq = eventsRef.current[0]?.seq ?? 0;
    if (oldestSeq <= 1) return;
    loadingEarlierRef.current = true;
    try {
      const earlier = await fetchEvents(id, 0, baseRef.current, { before: oldestSeq });
      if (cancelledRef.current || sessionIdRef.current !== id) return;
      updateEvents((prev) => mergeEvents(prev, earlier));
    } finally {
      loadingEarlierRef.current = false;
    }
  }, [updateEvents]);

  useEffect(() => {
    if (!sessionId) {
      replaceEvents([]);
      sinceRef.current = 0;
      cancelledRef.current = false;
      return;
    }

    cancelledRef.current = false;
    let cancelled = false;

    fetchInitial(sessionId).then((initial) => {
      if (cancelled) return;
      replaceEvents(initial);
      sinceRef.current = initial.reduce((max, e) => Math.max(max, e.seq), 0);
      connect();
    });

    const onVisibility = () => {
      if (document.visibilityState !== 'visible') return;
      if (subscriptionRef.current) subscriptionRef.current.resync();
      else connect();
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      cancelled = true;
      cancelledRef.current = true;
      document.removeEventListener('visibilitychange', onVisibility);
      subscriptionRef.current?.close();
      subscriptionRef.current = null;
    };
  }, [sessionId, base, connect, fetchInitial, replaceEvents]);

  const hasEarlier = (events[0]?.seq ?? 0) > 1;

  return { events, refetch, loadEarlier, hasEarlier };
}
