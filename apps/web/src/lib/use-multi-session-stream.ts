import { useCallback, useEffect, useRef, useState } from 'react';
import type { SessionEvent } from './api';
import { fetchEvents } from './api';
import { withBase } from './api-base';

const SSE_RECONNECT_MS = 2000;

type TaggedEvent = SessionEvent & { sessionId: string };

function appendInOrder(prev: SessionEvent[], event: SessionEvent): SessionEvent[] {
  const last = prev[prev.length - 1];
  if (last && event.seq > last.seq) return [...prev, event];
  if (prev.some((e) => e.seq === event.seq)) return prev;
  return [...prev, event].sort((a, b) => a.seq - b.seq);
}

/**
 * Streams many sessions over ONE SSE connection (`/api/sessions/stream/multi`).
 * Grid tiles each opening their own EventSource stall past the browser's ~6
 * connections-per-origin cap on HTTP/1.1 — this hook keeps a 3×3 grid live.
 */
export function useMultiSessionStream(
  sessionIds: string[],
  base = '',
): Record<string, SessionEvent[]> {
  const [eventsById, setEventsById] = useState<Record<string, SessionEvent[]>>({});
  const sinceByIdRef = useRef(new Map<string, number>());
  const sourceRef = useRef<EventSource | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelledRef = useRef(false);
  const baseRef = useRef(base);
  baseRef.current = base;
  const idsKey = sessionIds.join(',');
  const idsRef = useRef(sessionIds);
  idsRef.current = sessionIds;

  const clearReconnectTimer = useCallback(() => {
    if (reconnectTimerRef.current !== null) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  }, []);

  const connect = useCallback(() => {
    if (cancelledRef.current || idsRef.current.length === 0) return;
    clearReconnectTimer();
    sourceRef.current?.close();
    const activeKey = idsRef.current.join(',');
    const subs = idsRef.current
      .map((id) => `${id}:${sinceByIdRef.current.get(id) ?? 0}`)
      .join(',');
    const path = `/api/sessions/stream/multi?sessions=${encodeURIComponent(subs)}`;
    const url = baseRef.current ? withBase(path, baseRef.current) : withBase(path);
    const source = new EventSource(url);
    sourceRef.current = source;

    source.onmessage = (msg) => {
      const tagged = JSON.parse(msg.data) as TaggedEvent;
      const { sessionId, ...event } = tagged;
      if (!sessionId) return;
      sinceByIdRef.current.set(
        sessionId,
        Math.max(sinceByIdRef.current.get(sessionId) ?? 0, event.seq),
      );
      setEventsById((prev) => {
        const current = prev[sessionId] ?? [];
        const next = appendInOrder(current, event);
        if (next === current) return prev;
        return { ...prev, [sessionId]: next };
      });
    };

    source.onerror = () => {
      source.close();
      clearReconnectTimer();
      reconnectTimerRef.current = setTimeout(() => {
        reconnectTimerRef.current = null;
        if (!cancelledRef.current && idsRef.current.join(',') === activeKey) {
          connect();
        }
      }, SSE_RECONNECT_MS);
    };
  }, [clearReconnectTimer]);

  useEffect(() => {
    cancelledRef.current = false;
    const ids = idsKey ? idsKey.split(',') : [];
    if (ids.length === 0) {
      setEventsById({});
      sinceByIdRef.current.clear();
      return;
    }
    // Drop state for sessions that left the grid so it does not grow unbounded.
    for (const known of Array.from(sinceByIdRef.current.keys())) {
      if (!ids.includes(known)) sinceByIdRef.current.delete(known);
    }
    setEventsById((prev) => {
      const next: Record<string, SessionEvent[]> = {};
      for (const id of ids) if (prev[id]) next[id] = prev[id];
      return next;
    });

    let cancelled = false;
    void Promise.all(
      ids.map(async (id) => {
        try {
          const initial = await fetchEvents(id, 0, baseRef.current);
          if (cancelled) return;
          sinceByIdRef.current.set(
            id,
            initial.reduce((max, e) => Math.max(max, e.seq), 0),
          );
          setEventsById((prev) => ({ ...prev, [id]: initial }));
        } catch {
          // One unreachable session must not keep the rest of the grid dark;
          // the live stream still covers it from seq 0.
        }
      }),
    ).then(() => {
      if (!cancelled) connect();
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
  }, [idsKey, base, connect, clearReconnectTimer]);

  return eventsById;
}
