import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchEvents, type Session, type SessionEvent } from '@nuncio/core/api';
import {
  subscribeSessionEvents,
  type SessionSubscription,
  type WebSocketLike,
} from '@nuncio/core/session-relay-client';
import {
  DEFAULT_SESSION_DETAIL_EVENT_TAIL,
  hasEarlierSessionEvents,
  highestSessionEventSeq,
  mergeSessionEvents,
  nextSessionEventBackfillBefore,
  retainSessionEventWindow,
} from '@nuncio/core/session-event-window';
import { activeConnection, applyConnection } from './api-setup';
import { authHeader, relayUrlFor } from './connection-store';
import { type ConnectionManager, type ConnectionState } from './connection-manager';
import { createNativeConnectionManager } from './connection-manager-native';

type ScheduledFlush = {
  id: number;
  cancel: (id: number) => void;
};

const BOOTSTRAP_RELAY_FALLBACK_MS = 1_000;
const MOBILE_TRANSCRIPT_EVENT_TAIL = DEFAULT_SESSION_DETAIL_EVENT_TAIL;

/**
 * React Native cousin of the web's useSessionStream: a finite REST tail first,
 * then the core relay client over a Bearer-authenticated WebSocket. Older pages
 * remain available through loadEarlier; foreground/reconnect resumes from the
 * highest live seq so sleeping phones catch up gap-free.
 */
export function useSessionTranscript(sessionId: string | null) {
  const [events, setEvents] = useState<SessionEvent[]>([]);
  const [connectionState, setConnectionState] = useState<ConnectionState>('connecting');
  const eventsRef = useRef<SessionEvent[]>([]);
  const sinceRef = useRef(0);
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;
  const generationRef = useRef(0);
  const subscriptionRef = useRef<SessionSubscription | null>(null);
  const managerRef = useRef<ConnectionManager | null>(null);
  const loadingEarlierRef = useRef<Promise<void> | null>(null);
  const protectedThroughRef = useRef(0);
  const pendingProtectionThroughRef = useRef(0);
  const pendingEventsRef = useRef<SessionEvent[]>([]);
  const scheduledFlushRef = useRef<ScheduledFlush | null>(null);

  const replaceEvents = useCallback((next: SessionEvent[]) => {
    eventsRef.current = next;
    setEvents(next);
  }, []);

  const updateEvents = useCallback((updater: (prev: SessionEvent[]) => SessionEvent[]) => {
    const next = updater(eventsRef.current);
    eventsRef.current = next;
    setEvents(next);
  }, []);

  const applyRetention = useCallback((candidate: SessionEvent[]) => retainSessionEventWindow(
    candidate,
    MOBILE_TRANSCRIPT_EVENT_TAIL,
    Math.max(protectedThroughRef.current, pendingProtectionThroughRef.current),
  ), []);

  const flushPendingEvents = useCallback(() => {
    scheduledFlushRef.current = null;
    const pending = pendingEventsRef.current;
    if (pending.length === 0) return;
    pendingEventsRef.current = [];
    updateEvents((prev) => applyRetention(mergeSessionEvents(prev, pending)));
  }, [applyRetention, updateEvents]);

  const scheduleEventFlush = useCallback(() => {
    if (scheduledFlushRef.current) return;
    if (typeof requestAnimationFrame === 'function') {
      const id = requestAnimationFrame(flushPendingEvents);
      scheduledFlushRef.current = { id, cancel: (handle) => cancelAnimationFrame(handle) };
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

  const isCurrent = useCallback((id: string, generation: number) => (
    sessionIdRef.current === id && generationRef.current === generation
  ), []);

  const loadEarlier = useCallback((): Promise<void> => {
    if (loadingEarlierRef.current) return loadingEarlierRef.current;
    const id = sessionIdRef.current;
    const generation = generationRef.current;
    const before = nextSessionEventBackfillBefore(eventsRef.current);
    if (!id || before === null) return Promise.resolve();

    pendingProtectionThroughRef.current = Math.max(
      protectedThroughRef.current,
      highestSessionEventSeq(eventsRef.current),
    );
    let committed = false;
    const request = (async () => {
      let earlier: SessionEvent[];
      try {
        earlier = await fetchEvents(id, 0, '', { before });
      } catch (error) {
        if (isCurrent(id, generation)) throw error;
        return;
      }
      if (!isCurrent(id, generation)) return;

      const pending = pendingEventsRef.current;
      cancelPendingEventFlush();
      updateEvents((current) => {
        const merged = mergeSessionEvents(mergeSessionEvents(current, pending), earlier);
        protectedThroughRef.current = Math.max(
          protectedThroughRef.current,
          highestSessionEventSeq(merged),
        );
        pendingProtectionThroughRef.current = 0;
        return applyRetention(merged);
      });
      committed = true;
    })();
    loadingEarlierRef.current = request;
    const clear = () => {
      if (loadingEarlierRef.current !== request) return;
      loadingEarlierRef.current = null;
      if (!committed) {
        pendingProtectionThroughRef.current = 0;
        updateEvents((current) => applyRetention(current));
      }
    };
    void request.then(clear, clear);
    return request;
  }, [applyRetention, cancelPendingEventFlush, isCurrent, updateEvents]);

  useEffect(() => {
    const generation = ++generationRef.current;
    cancelPendingEventFlush();
    replaceEvents([]);
    sinceRef.current = 0;
    loadingEarlierRef.current = null;
    protectedThroughRef.current = 0;
    pendingProtectionThroughRef.current = 0;
    setConnectionState('connecting');

    if (!sessionId) return;
    const connection = activeConnection();
    if (!connection) return;

    let cancelled = false;
    let cleanupManager: (() => void) | null = null;
    let relayStarted = false;

    // A fresh subscription reads the live connection so URL/token rotation is
    // picked up. The manager remains the only reconnect authority.
    const openSubscription = () => {
      subscriptionRef.current?.close();
      const current = activeConnection() ?? connection;
      subscriptionRef.current = subscribeSessionEvents({
        url: relayUrlFor(current.serverUrl),
        sessionId,
        since: sinceRef.current,
        tail: MOBILE_TRANSCRIPT_EVENT_TAIL,
        onEvent,
        onNotice: (notice) => managerRef.current?.handleNotice(notice),
        onOpen: () => managerRef.current?.handleOpen(),
        onClose: () => managerRef.current?.handleClose(),
        shouldReconnect: () => managerRef.current?.shouldReconnect() ?? true,
        webSocketFactory: (url) => {
          // React Native accepts upgrade headers in the third constructor arg.
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

    const startRelay = () => {
      if (cancelled || relayStarted) return;
      relayStarted = true;
      let manager: ConnectionManager | null = null;
      let unsubscribe: (() => void) | null = null;
      try {
        manager = createNativeConnectionManager({
          candidateUrls: connection.candidateUrls ?? [connection.serverUrl],
          initialUrl: connection.serverUrl,
          onActiveUrl: (url) => {
            applyConnection({ ...(activeConnection() ?? connection), serverUrl: url });
          },
          reopen: openSubscription,
          resync: () => subscriptionRef.current?.confirmResync() ?? Promise.resolve(false),
        });
        managerRef.current = manager;
        unsubscribe = manager.subscribe(setConnectionState);
        openSubscription();
        manager.start();
        cleanupManager = () => {
          unsubscribe?.();
          manager?.dispose();
        };
      } catch {
        unsubscribe?.();
        manager?.dispose();
        if (managerRef.current === manager) managerRef.current = null;
        subscriptionRef.current?.close();
        subscriptionRef.current = null;
        relayStarted = false;
        setConnectionState('offline');
      }
    };

    const fallbackTimer = setTimeout(startRelay, BOOTSTRAP_RELAY_FALLBACK_MS);

    void (async () => {
      try {
        const initial = await fetchEvents(sessionId, 0, '', {
          tail: MOBILE_TRANSCRIPT_EVENT_TAIL,
        });
        if (!isCurrent(sessionId, generation)) return;
        updateEvents((current) => applyRetention(mergeSessionEvents(current, initial)));
        const fetchedSeq = initial.reduce((max, event) => Math.max(max, event.seq), 0);
        sinceRef.current = Math.max(sinceRef.current, fetchedSeq);
      } catch {
        // REST is a bootstrap optimization. Cursor-zero relay replay recovers a
        // transient HTTP failure without losing durable history.
      }
      if (!isCurrent(sessionId, generation)) return;
      clearTimeout(fallbackTimer);
      startRelay();
    })();

    return () => {
      cancelled = true;
      if (generationRef.current === generation) generationRef.current += 1;
      clearTimeout(fallbackTimer);
      cleanupManager?.();
      managerRef.current = null;
      subscriptionRef.current?.close();
      subscriptionRef.current = null;
      cancelPendingEventFlush();
    };
  }, [
    sessionId,
    onEvent,
    applyRetention,
    isCurrent,
    replaceEvents,
    updateEvents,
    cancelPendingEventFlush,
  ]);

  const steer = useCallback(
    async (message: string): Promise<Session> => {
      if (!sessionId || !subscriptionRef.current) throw new Error('Not connected');
      return (await subscriptionRef.current.call('steer', { sessionId, message })) as Session;
    },
    [sessionId],
  );

  const hasEarlier = hasEarlierSessionEvents(events);
  return { events, steer, connectionState, loadEarlier, hasEarlier };
}
