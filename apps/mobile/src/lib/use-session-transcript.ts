import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchEvents, type Session, type SessionEvent } from '@nuncio/core/api';
import {
  subscribeSessionEvents,
  type SessionSubscription,
  type WebSocketLike,
} from '@nuncio/core/session-relay-client';
import { activeConnection, applyConnection } from './api-setup';
import { authHeader, relayUrlFor } from './connection-store';
import { type ConnectionManager, type ConnectionState } from './connection-manager';
import { createNativeConnectionManager } from './connection-manager-native';

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
  const [connectionState, setConnectionState] = useState<ConnectionState>('connecting');
  const sinceRef = useRef(0);
  const subscriptionRef = useRef<SessionSubscription | null>(null);
  const managerRef = useRef<ConnectionManager | null>(null);
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
    let cleanupManager: (() => void) | null = null;

    // A fresh subscription reads the LIVE active connection, so a URL switch (or
    // a rotated secret) reconnects with the current base URL and bearer. The
    // manager is the sole reconnect authority: socket open/close are reported to
    // it, and it drives every reopen (probe → URL-switch → reopen, back off while
    // offline, freeze on server_shutdown). shouldReconnect keeps the relay from
    // reconnecting behind it.
    const openSubscription = () => {
      subscriptionRef.current?.close();
      const current = activeConnection() ?? connection;
      subscriptionRef.current = subscribeSessionEvents({
        url: relayUrlFor(current.serverUrl),
        sessionId,
        since: sinceRef.current,
        onEvent,
        onNotice: (notice) => managerRef.current?.handleNotice(notice),
        onOpen: () => managerRef.current?.handleOpen(),
        onClose: () => managerRef.current?.handleClose(),
        shouldReconnect: () => managerRef.current?.shouldReconnect() ?? true,
        webSocketFactory: (url) => {
          // RN's WebSocket accepts an options bag with headers as the third arg,
          // so the relay upgrade carries the same device/legacy bearer as REST.
          const RNWebSocket = WebSocket as unknown as new (
            u: string,
            protocols?: string[] | null,
            options?: { headers?: Record<string, string> },
          ) => WebSocketLike;
          const headers = authHeader(activeConnection() ?? current);
          return new RNWebSocket(url, null, Object.keys(headers).length ? { headers } : undefined);
        },
      });
    };

    fetchEvents(sessionId, 0).then((initial) => {
      if (cancelled) return;
      cancelPendingEventFlush();
      setEvents(initial);
      sinceRef.current = initial.reduce((max, e) => Math.max(max, e.seq), 0);

      // Create the manager BEFORE the first socket so its lifecycle hooks are
      // live from the very first connection, not just after a race.
      const manager = createNativeConnectionManager({
        candidateUrls: connection.candidateUrls ?? [connection.serverUrl],
        initialUrl: connection.serverUrl,
        onActiveUrl: (url) => {
          // Winner moved (network change): repoint the api client at the new base
          // URL, keeping the same credential. The manager reopens the socket next.
          applyConnection({ ...(activeConnection() ?? connection), serverUrl: url });
        },
        reopen: openSubscription,
      });
      managerRef.current = manager;
      const unsubscribe = manager.subscribe(setConnectionState);
      openSubscription();
      manager.start();
      cleanupManager = () => {
        unsubscribe();
        manager.dispose();
      };
    });

    return () => {
      cancelled = true;
      cleanupManager?.();
      managerRef.current = null;
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

  return { events, steer, connectionState };
}
