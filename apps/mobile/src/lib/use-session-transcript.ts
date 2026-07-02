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

  const onEvent = useCallback((event: SessionEvent) => {
    sinceRef.current = Math.max(sinceRef.current, event.seq);
    setEvents((prev) => {
      const last = prev[prev.length - 1];
      if (last && event.seq > last.seq) return [...prev, event];
      if (prev.some((e) => e.seq === event.seq)) return prev;
      return [...prev, event].sort((a, b) => a.seq - b.seq);
    });
  }, []);

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
    };
  }, [sessionId, onEvent]);

  const steer = useCallback(
    async (message: string): Promise<Session> => {
      if (!sessionId || !subscriptionRef.current) throw new Error('Not connected');
      return (await subscriptionRef.current.call('steer', { sessionId, message })) as Session;
    },
    [sessionId],
  );

  return { events, steer };
}
