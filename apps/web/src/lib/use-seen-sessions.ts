import { useCallback, useState } from 'react';
import type { Session } from './api';

const STORAGE_KEY = 'nuncio-board-seen';

/** sessionId → the `updatedAt` you last saw when you opened it. */
type SeenMap = Record<string, number>;

function load(): SeenMap {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as SeenMap) : {};
  } catch {
    return {};
  }
}

function persist(map: SeenMap): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    // Storage disabled or full — read state just won't survive this reload.
  }
}

export interface SeenSessions {
  /** True when the session has advanced past the last point you opened it. */
  isUnread: (session: Session) => boolean;
  /** Re-arm the watermark to the session's current `updatedAt` (you opened it). */
  markSeen: (session: Session) => void;
}

/**
 * Client-side "have you looked since it last changed", persisted per browser in
 * localStorage. A session is unread while its `updatedAt` sits ahead of the
 * watermark stored when you last opened it; the Board uses this to split the
 * finished/waiting sessions into Needs you vs Seen.
 */
export function useSeenSessions(): SeenSessions {
  const [seen, setSeen] = useState<SeenMap>(load);

  const isUnread = useCallback(
    (session: Session) => session.updatedAt > (seen[session.id] ?? 0),
    [seen],
  );

  const markSeen = useCallback((session: Session) => {
    setSeen((prev) => {
      // Already at this watermark — keep the ref stable to avoid a re-render.
      if (prev[session.id] === session.updatedAt) return prev;
      const next = { ...prev, [session.id]: session.updatedAt };
      persist(next);
      return next;
    });
  }, []);

  return { isUnread, markSeen };
}
