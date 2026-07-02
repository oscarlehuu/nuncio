import { useEffect, useRef, useState } from 'react';
import type { Session } from './api';
import { fetchActiveRun, refreshSessionTranscript } from './api';

/** Poll interval for CLI handoff active-run detection. */
export const ACTIVE_RUN_POLL_MS = 5000;

export type UseActiveRunOptions = {
  pollMs?: number;
  /** Called when refresh-transcript appended new events (client safety net). */
  onTranscriptRefreshed?: () => void;
};

function isCliHandoffSession(session: Session | null): session is Session {
  return (
    session != null &&
    session.provider === 'cursor' &&
    session.cursorBackend === 'cli'
  );
}

function isPiSession(session: Session | null): session is Session {
  return session != null && session.provider === 'pi';
}

/** Poll Cursor CLI handoff sessions for IDE activity on the host Mac. */
export function useActiveRun(
  session: Session | null,
  options: UseActiveRunOptions = {},
): boolean {
  const { pollMs = ACTIVE_RUN_POLL_MS, onTranscriptRefreshed } = options;
  const [active, setActive] = useState(false);
  const onRefreshedRef = useRef(onTranscriptRefreshed);
  onRefreshedRef.current = onTranscriptRefreshed;

  useEffect(() => {
    const isCli = isCliHandoffSession(session);
    const isPi = isPiSession(session);
    if (!isCli && !isPi) {
      setActive(false);
      return;
    }
    if (isPi) setActive(false);

    let cancelled = false;
    const sessionId = session.id;

    const poll = async () => {
      try {
        const [activeResult, refreshResult] = await Promise.all([
          // fetchActiveRun is cursor-specific; skip it for pi sessions.
          isCli ? fetchActiveRun(sessionId) : Promise.resolve({ active: false }),
          refreshSessionTranscript(sessionId).catch(() => ({ added: 0 })),
        ]);
        if (cancelled) return;
        if (isCli) setActive(activeResult.active);
        if (refreshResult.added > 0) {
          onRefreshedRef.current?.();
        }
      } catch {
        // Ignore transient poll failures.
      }
    };

    void poll();
    const timer = setInterval(() => void poll(), pollMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [session?.id, session?.provider, session?.cursorBackend, pollMs]);

  return active;
}
