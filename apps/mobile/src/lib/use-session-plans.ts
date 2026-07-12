import { useEffect, useRef, useState } from 'react';
import { fetchEvents, type Session } from '@nuncio/core/api';
import { derivePlan } from '@nuncio/core/derive-plan';
import type { PlanItem } from '@nuncio/core/plan.types';

// A plan only matters while a session is live; terminal/idle-forever sessions
// are skipped so the list does not fan out a request per archived row.
const PLAN_STATUSES: ReadonlySet<Session['status']> = new Set(['RUNNING', 'IDLE', 'PAUSED']);
// plan_updated carries the full snapshot on every change, so the newest window
// almost always holds the current plan for an active session. Best-effort: a
// plan that scrolled out of the tail simply doesn't show a step count.
const EVENT_TAIL = 400;
// Freshness is time-based, NOT keyed on session.updatedAt: plan_updated does not
// bump updatedAt (so keying on it would never refresh), while preview/status
// writes bump it every ~250ms (so keying on it would refetch in a storm). A
// short TTL re-polls live sessions without churning on unrelated row updates.
const SUCCESS_TTL_MS = 45_000;
// Retry a transient failure soon, but never treat it as a durable "no plan".
const FAILURE_TTL_MS = 8_000;
// Bound the tail fetches so a large list (× a 250ms preview cadence) can't storm.
const MAX_CONCURRENT = 4;

interface PlanEntry {
  items: PlanItem[] | null;
  fetchedAt: number;
  ok: boolean;
}

function samePlans(a: Map<string, PlanItem[]>, b: Map<string, PlanItem[]>): boolean {
  if (a.size !== b.size) return false;
  for (const [id, items] of a) {
    if (b.get(id) !== items) return false;
  }
  return true;
}

/**
 * Best-effort plan lookup for session-list rows. Session summaries carry no plan
 * data, so we lazily read a tail of each live session's events, derive the plan,
 * and cache per session id with a short TTL — a re-focus inside the window
 * refetches nothing, failures retry soon, and errors degrade to "no plan"
 * rather than surfacing on the row.
 */
export function useSessionPlans(sessions: Session[]): Map<string, PlanItem[]> {
  const [plans, setPlans] = useState<Map<string, PlanItem[]>>(new Map());
  const cacheRef = useRef<Map<string, PlanEntry>>(new Map());
  const inFlightRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    const eligible = sessions.filter((session) => PLAN_STATUSES.has(session.status));

    const syncFromCache = () => {
      if (cancelled) return;
      const next = new Map<string, PlanItem[]>();
      for (const session of eligible) {
        const entry = cacheRef.current.get(session.id);
        if (entry?.ok && entry.items && entry.items.length > 0) next.set(session.id, entry.items);
      }
      // Skip the render when nothing changed — the sessions array churns on the
      // preview cadence, so an unguarded setState would re-render the list ~4×/s.
      setPlans((prev) => (samePlans(prev, next) ? prev : next));
    };

    const isStale = (session: Session): boolean => {
      const entry = cacheRef.current.get(session.id);
      if (!entry) return true;
      const ttl = entry.ok ? SUCCESS_TTL_MS : FAILURE_TTL_MS;
      return Date.now() - entry.fetchedAt > ttl;
    };

    const queue = eligible.filter(
      (session) => isStale(session) && !inFlightRef.current.has(session.id),
    );

    // Reflect whatever is already cached immediately, then fill in the gaps.
    syncFromCache();

    if (queue.length === 0) {
      return () => {
        cancelled = true;
      };
    }

    let cursor = 0;
    const runNext = async (): Promise<void> => {
      const session = queue[cursor++];
      if (!session) return;
      inFlightRef.current.add(session.id);
      try {
        const events = await fetchEvents(session.id, 0, '', { tail: EVENT_TAIL });
        cacheRef.current.set(session.id, {
          items: derivePlan(events) ?? null,
          fetchedAt: Date.now(),
          ok: true,
        });
      } catch {
        cacheRef.current.set(session.id, { items: null, fetchedAt: Date.now(), ok: false });
      } finally {
        inFlightRef.current.delete(session.id);
      }
      await runNext();
    };

    const workers = Array.from({ length: Math.min(MAX_CONCURRENT, queue.length) }, () => runNext());
    void Promise.all(workers).then(syncFromCache);

    return () => {
      cancelled = true;
    };
  }, [sessions]);

  return plans;
}
