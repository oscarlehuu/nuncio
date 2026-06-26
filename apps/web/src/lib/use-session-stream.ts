import { useCallback, useEffect, useRef, useState } from 'react';
import type { SessionEvent } from './api';
import { fetchEvents } from './api';

export function useSessionStream(sessionId: string | null) {
  const [events, setEvents] = useState<SessionEvent[]>([]);
  const sinceRef = useRef(0);
  const sourceRef = useRef<EventSource | null>(null);

  const connect = useCallback(() => {
    if (!sessionId) return;
    sourceRef.current?.close();
    const url = `/api/sessions/${sessionId}/stream?since=${sinceRef.current}`;
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
  }, [sessionId]);

  useEffect(() => {
    if (!sessionId) {
      setEvents([]);
      sinceRef.current = 0;
      return;
    }

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
      document.removeEventListener('visibilitychange', onVisibility);
      sourceRef.current?.close();
    };
  }, [sessionId, connect]);

  return events;
}
