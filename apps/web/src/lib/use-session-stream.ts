import { useCallback, useEffect, useRef, useState } from 'react';
import type { SessionEvent } from './api';
import { fetchEvents } from './api';
import { withBase } from './api-base';

const SSE_RECONNECT_MS = 2000;

/**
 * `base` targets a specific machine's API (origin-absolute, hub mode); the
 * default empty string keeps page-relative behavior (rewritten by the page's
 * own hub base where applicable).
 */
export function useSessionStream(sessionId: string | null, base = '') {
  const [events, setEvents] = useState<SessionEvent[]>([]);
  const sinceRef = useRef(0);
  const sourceRef = useRef<EventSource | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelledRef = useRef(false);
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;
  const baseRef = useRef(base);
  baseRef.current = base;

  const clearReconnectTimer = useCallback(() => {
    if (reconnectTimerRef.current !== null) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
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
    const initial = await fetchEvents(sessionId, 0, baseRef.current);
    if (cancelledRef.current) return;
    setEvents(initial);
    sinceRef.current = initial.reduce((max, e) => Math.max(max, e.seq), 0);
    connect();
  }, [sessionId, connect]);

  useEffect(() => {
    if (!sessionId) {
      setEvents([]);
      sinceRef.current = 0;
      cancelledRef.current = false;
      return;
    }

    cancelledRef.current = false;
    let cancelled = false;

    fetchEvents(sessionId, 0, baseRef.current).then((initial) => {
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
  }, [sessionId, base, connect, clearReconnectTimer]);

  return { events, refetch };
}
