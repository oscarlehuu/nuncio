import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { fetchEvents, type Session, type SessionEvent } from '@nuncio/core/api';
import {
  subscribeSessionEvents,
  type SessionSubscription,
  type WebSocketLike,
} from '@nuncio/core/session-relay-client';
import { activeConnection } from './api-setup';
import { relayUrlFor } from './connection-store';

type ScheduledFlush = {
  id: number;
  cancel: (id: number) => void;
};

function mergeEvents(prev: SessionEvent[], incoming: SessionEvent[]): SessionEvent[] {
  if (incoming.length === 0) return prev;
  const seen = new Set(prev.map((event) => event.seq));
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
 * React Native cousin of the web's useSessionStream: REST replay first, then
 * the core relay client over a Bearer-authenticated WebSocket. Foregrounding
 * the app resyncs from the last seen seq, so a backgrounded phone catches up
 * gap-free.
 */
export function useSessionTranscript(sessionId: string | null) {
  const [events, setEvents] = useState<SessionEvent[]>([]);
  const sinceRef = useRef(0);
  const subscriptionRef = useRef<SessionSubscription | null>(null);
  const pendingEventsRef = useRef<SessionEvent[]>([]);
  const scheduledFlushRef = useRef<ScheduledFlush | null>(null);

  const flushPendingEvents = useCallback(() => {
    scheduledFlushRef.current = null;
    const pending = pendingEventsRef.current;
    if (pending.length === 0) return;
    pendingEventsRef.current = [];
    setEvents((prev) => mergeEvents(prev, pending));
  }, []);

  const scheduleEventFlush = useCallback(() => {
    if (scheduledFlushRef.current) return;
    if (typeof requestAnimationFrame === 'function') {
      const id = requestAnimationFrame(flushPendingEvents);
      scheduledFlushRef.current = { id, cancel: cancelAnimationFrame };
      return;
    }
    const id = setTimeout(flushPendingEvents, 16) as unknown as number;
    scheduledFlushRef.current = { id, cancel: (handle) => clearTimeout(handle) };
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

  useEffect(() => {
    if (!sessionId) {
      setEvents([]);
      sinceRef.current = 0;
      return;
    }
    const connection = activeConnection();
    if (!connection) return;

    let cancelled = false;
    fetchEvents(sessionId, 0).then((initial) => {
      if (cancelled) return;
      cancelPendingEventFlush();
      setEvents(initial);
      sinceRef.current = initial.reduce((max, e) => Math.max(max, e.seq), 0);
      subscriptionRef.current = subscribeSessionEvents({
        url: relayUrlFor(connection.serverUrl),
        sessionId,
        since: sinceRef.current,
        onEvent,
        webSocketFactory: (url) => {
          // RN's WebSocket accepts an options bag with headers as the third arg.
          const RNWebSocket = WebSocket as unknown as new (
            u: string,
            protocols?: string[] | null,
            options?: { headers?: Record<string, string> },
          ) => WebSocketLike;
          return new RNWebSocket(
            url,
            null,
            connection.token
              ? { headers: { Authorization: `Bearer ${connection.token}` } }
              : undefined,
          );
        },
      });
    });

    const appState = AppState.addEventListener('change', (state) => {
      if (state === 'active') subscriptionRef.current?.resync();
    });

    return () => {
      cancelled = true;
      appState.remove();
      subscriptionRef.current?.close();
      subscriptionRef.current = null;
      cancelPendingEventFlush();
    };
  }, [sessionId, onEvent, cancelPendingEventFlush]);

  const steer = useCallback(
    async (message: string): Promise<Session> => {
      if (!sessionId || !subscriptionRef.current) throw new Error('Not connected');
      return (await subscriptionRef.current.call('steer', { sessionId, message })) as Session;
    },
    [sessionId],
  );

  return { events, steer };
}
