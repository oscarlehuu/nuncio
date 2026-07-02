import { useEffect, useRef } from 'react';
import type { Session } from './api';

export type SessionNotificationKind = 'finished' | 'error' | 'needs-input';

export interface SessionNotificationEvent {
  kind: SessionNotificationKind;
  title: string;
  body: string;
  sessionId: string;
}

interface PrevSessionState {
  status: Session['status'];
}

export type PrevSessionMap = Map<string, PrevSessionState>;

export interface NuncioDesktopTerminalApi {
  create: (payload: { id: string; cwd?: string; cols?: number; rows?: number }) => Promise<unknown>;
  write: (id: string, data: string) => Promise<unknown> | void;
  resize: (id: string, cols: number, rows: number) => Promise<unknown> | void;
  kill: (id: string) => Promise<unknown> | void;
  onData: (cb: (payload: { id: string; data: string }) => void) => () => void;
  onExit: (cb: (payload: { id: string; code: number | null }) => void) => () => void;
}

export interface NuncioDesktopBrowserBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface NuncioDesktopBrowserState {
  url: string | null;
  title: string | null;
  loading: boolean;
}

export interface NuncioDesktopBrowserApi {
  show: (payload: {
    id: string;
    url?: string;
    bounds: NuncioDesktopBrowserBounds;
  }) => Promise<NuncioDesktopBrowserState>;
  navigate: (id: string, url: string) => Promise<NuncioDesktopBrowserState>;
  reload: (id: string) => Promise<NuncioDesktopBrowserState>;
  resize: (id: string, bounds: NuncioDesktopBrowserBounds) => Promise<NuncioDesktopBrowserState | null>;
  hide: (id: string) => Promise<unknown> | void;
}

// TODO: Session (list payload) currently has no pending-input flag (e.g.
// pendingUserInput/awaitingInput). Pending input is only derivable from a
// session's own event stream (see derive-pending-user-input.ts), which isn't
// available in the polled session list. Once the list payload exposes such a
// flag, wire a 'needs-input' transition here without adding new endpoints.

export function computeSessionNotifications(
  prevMap: PrevSessionMap,
  sessions: Session[],
  activeSessionId: string | null,
): { events: SessionNotificationEvent[]; nextMap: PrevSessionMap } {
  const events: SessionNotificationEvent[] = [];
  const nextMap: PrevSessionMap = new Map();
  const isInitialLoad = prevMap.size === 0;

  for (const session of sessions) {
    const prev = prevMap.get(session.id);
    nextMap.set(session.id, { status: session.status });

    if (!prev) {
      // First time we've seen this session: seed without firing.
      continue;
    }

    if (isInitialLoad) continue;
    if (session.id === activeSessionId) continue;

    if (prev.status !== session.status) {
      if (prev.status === 'RUNNING' && session.status === 'IDLE') {
        events.push({
          kind: 'finished',
          title: 'Session finished',
          body: session.title,
          sessionId: session.id,
        });
      } else if (session.status === 'ERROR') {
        events.push({
          kind: 'error',
          title: 'Session error',
          body: session.title,
          sessionId: session.id,
        });
      }
    }
  }

  return { events, nextMap };
}

export function useSessionNotifications(sessions: Session[], activeSessionId: string | null) {
  const prevMapRef = useRef<PrevSessionMap>(new Map());

  useEffect(() => {
    const { events, nextMap } = computeSessionNotifications(
      prevMapRef.current,
      sessions,
      activeSessionId,
    );
    prevMapRef.current = nextMap;

    for (const event of events) {
      try {
        void window.nuncioDesktop?.notify?.({
          title: event.title,
          body: event.body,
          sessionId: event.sessionId,
        });
      } catch {
        // no-op: desktop bridge unavailable or notification failed
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions]);
}

declare global {
  interface Window {
    nuncioDesktop?: {
      marker?: string;
      electron?: string;
      notify?: (payload: { title: string; body: string; sessionId: string }) => Promise<unknown> | void;
      browser?: NuncioDesktopBrowserApi;
      terminal?: NuncioDesktopTerminalApi;
    };
  }
}
