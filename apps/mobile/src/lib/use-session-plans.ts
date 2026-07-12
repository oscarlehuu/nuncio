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

/**
 * Best-effort plan lookup for session-list rows. Session summaries carry no plan
 * data, so we lazily read a tail of each live session's events, derive the plan,
 * and cache by id+updatedAt — a re-focus with unchanged sessions refetches
 * nothing. Errors degrade to "no plan" rather than surfacing on the row.
 */
export function useSessionPlans(sessions: Session[]): Map<string, PlanItem[]> {
  const [plans, setPlans] = useState<Map<string, PlanItem[]>>(new Map());
  const cacheRef = useRef<Map<string, PlanItem[] | null>>(new Map());

  useEffect(() => {
    let cancelled = false;
    const eligible = sessions.filter((session) => PLAN_STATUSES.has(session.status));

    const syncFromCache = () => {
      if (cancelled) return;
      const next = new Map<string, PlanItem[]>();
      for (const session of eligible) {
        const items = cacheRef.current.get(`${session.id}:${session.updatedAt}`);
        if (items && items.length > 0) next.set(session.id, items);
      }
      setPlans(next);
    };

    const stale = eligible.filter(
      (session) => !cacheRef.current.has(`${session.id}:${session.updatedAt}`),
    );

    if (stale.length === 0) {
      syncFromCache();
      return () => {
        cancelled = true;
      };
    }

    void Promise.all(
      stale.map(async (session) => {
        const key = `${session.id}:${session.updatedAt}`;
        try {
          const events = await fetchEvents(session.id, 0, '', { tail: EVENT_TAIL });
          cacheRef.current.set(key, derivePlan(events) ?? null);
        } catch {
          cacheRef.current.set(key, null);
        }
      }),
    ).then(syncFromCache);

    return () => {
      cancelled = true;
    };
  }, [sessions]);

  return plans;
}
