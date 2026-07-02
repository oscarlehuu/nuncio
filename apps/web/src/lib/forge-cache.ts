// Tiny stale-while-revalidate cache for forge data. Module-level, so entries
// survive segment switches and component unmounts: revisiting a tab renders
// the cached data instantly while a background revalidation fetches updates.

import { useCallback, useEffect, useRef, useState } from 'react';

interface CacheEntry {
  data: unknown;
  fetchedAt: number;
}

const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<unknown>>();
const listeners = new Map<string, Set<() => void>>();

const MAX_ENTRIES = 200;

function emit(key: string): void {
  for (const listener of listeners.get(key) ?? []) listener();
}

/** Fetch and store; concurrent callers for the same key share one request. */
function revalidate<T>(key: string, fetcher: () => Promise<T>): Promise<T> {
  const existing = inflight.get(key) as Promise<T> | undefined;
  if (existing) return existing;
  const promise = fetcher()
    .then((data) => {
      const prev = cache.get(key);
      // Keep the previous reference when payloads are identical — subscribers
      // skip a re-render and lists don't flicker on no-op refreshes.
      const unchanged = prev !== undefined && JSON.stringify(prev.data) === JSON.stringify(data);
      cache.set(key, { data: unchanged ? prev.data : data, fetchedAt: Date.now() });
      if (cache.size > MAX_ENTRIES) {
        const oldest = cache.keys().next().value;
        if (oldest && oldest !== key) cache.delete(oldest);
      }
      if (!unchanged) emit(key);
      return data;
    })
    .finally(() => {
      inflight.delete(key);
    });
  inflight.set(key, promise);
  return promise;
}

/** Drop cached entries whose key starts with `prefix` (or all when omitted). */
export function clearForgeCache(prefix?: string): void {
  if (prefix === undefined) {
    cache.clear();
    return;
  }
  for (const key of [...cache.keys()]) {
    if (key.startsWith(prefix)) cache.delete(key);
  }
}

export interface ForgeQueryOptions {
  /** Cached data older than this triggers a background revalidation on mount/focus. */
  staleMs?: number;
  /** Revalidate on this interval while mounted. */
  pollMs?: number;
  /** Called when a fetch fails and nothing is cached (initial load failure). */
  onError?: (error: Error) => void;
}

export interface ForgeQueryResult<T> {
  /** Cached or fresh data; null until the first fetch resolves. */
  data: T | null;
  /** Force a revalidation (after a mutation); rejects on failure. */
  refresh: () => Promise<void>;
}

export function useForgeQuery<T>(
  key: string | null,
  fetcher: () => Promise<T>,
  options: ForgeQueryOptions = {},
): ForgeQueryResult<T> {
  const { staleMs = 15_000, pollMs, onError } = options;
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const [, force] = useState(0);

  useEffect(() => {
    if (!key) return;
    const listener = () => force((n) => n + 1);
    let set = listeners.get(key);
    if (!set) {
      set = new Set();
      listeners.set(key, set);
    }
    set.add(listener);

    const kick = () => {
      const entry = cache.get(key);
      if (entry && Date.now() - entry.fetchedAt <= staleMs) return;
      revalidate(key, () => fetcherRef.current()).catch((err: unknown) => {
        if (!cache.has(key)) {
          onErrorRef.current?.(err instanceof Error ? err : new Error(String(err)));
          // Subscribers re-render so components can leave their loading state.
          cache.set(key, { data: null, fetchedAt: Date.now() });
          emit(key);
        }
      });
    };

    kick();
    // A remount between renders keeps the cached entry — re-render immediately.
    force((n) => n + 1);
    const onFocus = () => kick();
    window.addEventListener('focus', onFocus);
    const timer = pollMs
      ? setInterval(() => {
          revalidate(key, () => fetcherRef.current()).catch(() => {
            // Background poll failure: keep showing the stale data.
          });
        }, pollMs)
      : null;

    return () => {
      set.delete(listener);
      if (set.size === 0) listeners.delete(key);
      window.removeEventListener('focus', onFocus);
      if (timer) clearInterval(timer);
    };
  }, [key, staleMs, pollMs]);

  const refresh = useCallback(async () => {
    if (!key) return;
    await revalidate(key, () => fetcherRef.current());
  }, [key]);

  const entry = key ? cache.get(key) : undefined;
  return { data: (entry?.data as T | null) ?? null, refresh };
}
