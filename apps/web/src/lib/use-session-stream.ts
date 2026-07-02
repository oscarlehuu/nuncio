import { useCallback, useEffect, useRef, useState } from 'react';
import type { SessionEvent } from './api';
import { fetchEvents } from './api';
import { withBase } from './api-base';

const SSE_RECONNECT_MS = 2000;

/** Initial window for the full session view; older history pages in on demand. */
export const DETAIL_EVENT_TAIL = 1000;

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
  const sourceRef = useRef<EventSource | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelledRef = useRef(false);
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;
  const baseRef = useRef(base);
  baseRef.current = base;
  const tailRef = useRef(tail);
  tailRef.current = tail;
  const eventsRef = useRef<SessionEvent[]>([]);
  const loadingEarlierRef = useRef(false);

  useEffect(() => {
    eventsRef.current = events;
  }, [events]);

  const clearReconnectTimer = useCallback(() => {
    if (reconnectTimerRef.current !== null) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  }, []);

  const fetchInitial = useCallback((id: string) => {
    const depth = tailRef.current;
    return depth !== undefined
      ? fetchEvents(id, 0, baseRef.current, { tail: depth })
      : fetchEvents(id, 0, baseRef.current);
  }, []);

  const connect = useCallback(() => {
    const activeSessionId = sessionIdRef.current;
    if (!activeSessionId || cancelledRef.current) return;
    clearReconnectTimer();
    sourceRef.current?.close();
    // EventSource is not covered by the page's fetch rewrite, so the hub base
    // (page-level or per-call) must be applied here explicitly.
    const path = `/api/sessions/${activeSessionId}/stream?since=${sinceRef.current}`;
    const url = baseRef.current ? withBase(path, baseRef.current) : withBase(path);
    const source = new EventSource(url);
    sourceRef.current = source;

    source.onmessage = (msg) => {
      const event = JSON.parse(msg.data) as SessionEvent;
      sinceRef.current = Math.max(sinceRef.current, event.seq);
      setEvents((prev) => {
        const last = prev[prev.length - 1];
        if (last && event.seq > last.seq) return [...prev, event];
        if (prev.some((e) => e.seq === event.seq)) return prev;
        return [...prev, event].sort((a, b) => a.seq - b.seq);
      });
    };

    source.onerror = () => {
      source.close();
      clearReconnectTimer();
      reconnectTimerRef.current = setTimeout(() => {
        reconnectTimerRef.current = null;
        if (!cancelledRef.current && sessionIdRef.current === activeSessionId) {
          connect();
        }
      }, SSE_RECONNECT_MS);
    };
  }, [clearReconnectTimer]);

  const refetch = useCallback(async () => {
    if (!sessionId || cancelledRef.current) return;
    const initial = await fetchInitial(sessionId);
    if (cancelledRef.current) return;
    setEvents(initial);
    sinceRef.current = initial.reduce((max, e) => Math.max(max, e.seq), 0);
    connect();
  }, [sessionId, connect, fetchInitial]);

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
      setEvents((prev) => mergeEvents(prev, earlier));
    } finally {
      loadingEarlierRef.current = false;
    }
  }, []);

  useEffect(() => {
    if (!sessionId) {
      setEvents([]);
      sinceRef.current = 0;
      cancelledRef.current = false;
      return;
    }

    cancelledRef.current = false;
    let cancelled = false;

    fetchInitial(sessionId).then((initial) => {
      if (cancelled) return;
      setEvents(initial);
      sinceRef.current = initial.reduce((max, e) => Math.max(max, e.seq), 0);
      connect();
    });

    const onVisibility = () => {
      if (document.visibilityState === 'visible') connect();
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      cancelled = true;
      cancelledRef.current = true;
      clearReconnectTimer();
      document.removeEventListener('visibilitychange', onVisibility);
      sourceRef.current?.close();
    };
  }, [sessionId, base, connect, clearReconnectTimer, fetchInitial]);

  const hasEarlier = (events[0]?.seq ?? 0) > 1;

  return { events, refetch, loadEarlier, hasEarlier };
}
