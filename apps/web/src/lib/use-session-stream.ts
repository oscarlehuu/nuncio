import { useCallback, useEffect, useRef, useState } from 'react';
import type { SessionEvent } from './api';
import { fetchEvents } from './api';

const SSE_RECONNECT_MS = 2000;

export function useSessionStream(sessionId: string | null) {
  const [events, setEvents] = useState<SessionEvent[]>([]);
  const sinceRef = useRef(0);
  const sourceRef = useRef<EventSource | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelledRef = useRef(false);
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;

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
    const url = `/api/sessions/${activeSessionId}/stream?since=${sinceRef.current}`;
    const source = new EventSource(url);
    sourceRef.current = source;

    source.onmessage = (msg) => {
      const event = JSON.parse(msg.data) as SessionEvent;
      sinceRef.current = Math.max(sinceRef.current, event.seq);
      setEvents((prev) => {
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
    const initial = await fetchEvents(sessionId, 0);
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

    fetchEvents(sessionId, 0).then((initial) => {
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
  }, [sessionId, connect, clearReconnectTimer]);

  return { events, refetch };
}
