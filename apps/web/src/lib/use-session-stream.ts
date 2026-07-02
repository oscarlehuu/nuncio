import { useCallback, useEffect, useRef, useState } from 'react';
import type { SessionEvent } from './api';
import { fetchEvents } from './api';
import { withBase } from './api-base';
import {
  subscribeSessionEvents,
  type SessionSubscription,
} from '@nuncio/core/session-relay-client';

/** ws(s):// URL of the session relay (page hub base, or an explicit machine base). */
export function sessionRelayUrl(base = ''): string {
  const path = '/api/sessions/ws';
  const prefixed = base ? withBase(path, base) : withBase(path);
  const url = new URL(prefixed, window.location.origin);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

/**
 * `base` targets a specific machine's API (origin-absolute, hub mode); the
 * default empty string keeps page-relative behavior (rewritten by the page's
 * own hub base where applicable).
 */
export function useSessionStream(sessionId: string | null, base = '') {
  const [events, setEvents] = useState<SessionEvent[]>([]);
  const sinceRef = useRef(0);
  const subscriptionRef = useRef<SessionSubscription | null>(null);
  const cancelledRef = useRef(false);
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;
  const baseRef = useRef(base);
  baseRef.current = base;

  const onEvent = useCallback((event: SessionEvent) => {
    sinceRef.current = Math.max(sinceRef.current, event.seq);
    setEvents((prev) => {
      const last = prev[prev.length - 1];
      if (last && event.seq > last.seq) return [...prev, event];
      if (prev.some((e) => e.seq === event.seq)) return prev;
      return [...prev, event].sort((a, b) => a.seq - b.seq);
    });
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
  }, [sessionId, base, connect]);

  return { events, refetch };
}
