/**
 * In-memory client cache for provider usage + history.
 * Soft TTL (5m): revisiting Usage/Settings reuses data; a background tick
 * only hits the network when the cache is actually stale (or force=true).
 */

import {
  fetchProviderUsage,
  fetchUsageHistory,
  type UsageHistoryDto,
  type UsageSnapshotDto,
} from './usage-api';

export const USAGE_CACHE_TTL_MS = 5 * 60_000;
/** How often mounted subscribers check whether a pull is due. */
export const USAGE_CACHE_TICK_MS = 30_000;

export interface UsageCacheState {
  snapshots: UsageSnapshotDto[];
  history: UsageHistoryDto | null;
  /** Wall-clock when snapshots were last successfully pulled. */
  fetchedAt: number | null;
  /** Wall-clock when history was last successfully pulled. */
  historyFetchedAt: number | null;
  loading: boolean;
  error: string | null;
}

type Listener = () => void;

let state: UsageCacheState = {
  snapshots: [],
  history: null,
  fetchedAt: null,
  historyFetchedAt: null,
  loading: false,
  error: null,
};

const listeners = new Set<Listener>();
let inflight: Promise<void> | null = null;
let subscriberCount = 0;
let tickId: ReturnType<typeof setInterval> | null = null;
let nowFn: () => number = () => Date.now();

function emit(): void {
  for (const listener of listeners) listener();
}

function setState(patch: Partial<UsageCacheState>): void {
  state = { ...state, ...patch };
  emit();
}

export function getUsageCacheState(): UsageCacheState {
  return state;
}

export function isUsageCacheFresh(
  fetchedAt: number | null,
  ttlMs: number = USAGE_CACHE_TTL_MS,
  nowMs: number = nowFn(),
): boolean {
  return fetchedAt != null && nowMs - fetchedAt < ttlMs;
}

export function subscribeUsageCache(listener: Listener): () => void {
  listeners.add(listener);
  subscriberCount += 1;
  ensureTick();
  return () => {
    listeners.delete(listener);
    subscriberCount = Math.max(0, subscriberCount - 1);
    if (subscriberCount === 0 && tickId != null) {
      clearInterval(tickId);
      tickId = null;
    }
  };
}

function ensureTick(): void {
  if (typeof window === 'undefined') return;
  if (tickId != null) return;
  tickId = setInterval(() => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    void ensureUsageCache({ force: false, history: state.history != null || state.historyFetchedAt != null });
  }, USAGE_CACHE_TICK_MS);
}

export interface EnsureUsageCacheOptions {
  /** Bypass soft TTL and ask the server to bypass its cache too. */
  force?: boolean;
  /** Also ensure history is present/fresh (Settings chart). */
  history?: boolean;
  days?: number;
}

/**
 * Return cached data when fresh; otherwise pull. Concurrent callers coalesce
 * onto one in-flight request.
 */
export async function ensureUsageCache(
  options: EnsureUsageCacheOptions = {},
): Promise<UsageCacheState> {
  const force = options.force === true;
  const wantHistory = options.history === true;

  const plan = () => {
    const now = nowFn();
    return {
      needSnapshots: force || !isUsageCacheFresh(state.fetchedAt, USAGE_CACHE_TTL_MS, now),
      needHistory:
        wantHistory &&
        (force || !isUsageCacheFresh(state.historyFetchedAt, USAGE_CACHE_TTL_MS, now)),
    };
  };

  let { needSnapshots, needHistory } = plan();
  if (!needSnapshots && !needHistory) {
    return state;
  }

  if (inflight) {
    await inflight;
    ({ needSnapshots, needHistory } = plan());
    if (!needSnapshots && !needHistory) {
      return state;
    }
  }

  // Another waiter may have started work while we re-planned.
  if (inflight) {
    await inflight;
    return state;
  }

  const showLoading = state.fetchedAt == null && needSnapshots;
  setState({
    loading: showLoading,
    error: null,
  });

  const run = (async () => {
    try {
      const tasks: Array<Promise<void>> = [];
      if (needSnapshots) {
        tasks.push(
          fetchProviderUsage({ forceRefresh: force }).then((snapshots) => {
            setState({
              snapshots,
              fetchedAt: nowFn(),
              error: null,
            });
          }),
        );
      }
      if (needHistory) {
        tasks.push(
          fetchUsageHistory({ days: options.days ?? 90, forceRefresh: force }).then((history) => {
            setState({
              history,
              historyFetchedAt: nowFn(),
              error: null,
            });
          }),
        );
      }
      await Promise.all(tasks);
    } catch (err) {
      setState({
        error: (err as Error)?.message ?? 'Failed to load usage',
      });
    } finally {
      setState({ loading: false });
    }
  })();

  inflight = run.finally(() => {
    inflight = null;
  });

  await inflight;
  return state;
}

/** Test helper: reset singleton state + timers. */
export function resetUsageCacheForTests(options?: { now?: () => number }): void {
  if (tickId != null) {
    clearInterval(tickId);
    tickId = null;
  }
  subscriberCount = 0;
  listeners.clear();
  inflight = null;
  nowFn = options?.now ?? (() => Date.now());
  state = {
    snapshots: [],
    history: null,
    fetchedAt: null,
    historyFetchedAt: null,
    loading: false,
    error: null,
  };
}

/** Test helper: seed cache without network. */
export function seedUsageCacheForTests(partial: Partial<UsageCacheState>): void {
  state = { ...state, ...partial };
  emit();
}
