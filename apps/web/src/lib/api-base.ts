/**
 * Base-path resolution for hub mode. When the app is served directly by a
 * machine's own daemon, every request stays at the root (`base === ''`). When
 * it is served through the hub under `/m/<machine>/`, all API/SSE/WS URLs and
 * the react-router basename must carry that prefix so requests route to the
 * right machine. This layer keeps the ~40 call sites prefix-agnostic.
 */

// Hostname characters only (letters, digits, dot, hyphen). Anything else is
// not a machine segment — prevents a bogus prefix from shaping traffic.
const MACHINE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9.-]*$/;

export function resolveBasePath(pathname: string): string {
  const match = /^\/m\/([^/]+)(?:\/|$)/.exec(pathname);
  if (!match) return '';
  const machine = decodeURIComponent(match[1]);
  if (!MACHINE_SEGMENT.test(machine)) return '';
  return `/m/${match[1]}`;
}

/** The app's base path for this page load, computed once. */
export const API_BASE: string =
  typeof window !== 'undefined' ? resolveBasePath(window.location.pathname) : '';

export function withBase(path: string, base: string = API_BASE): string {
  return `${base}${path}`;
}

export function toWsUrl(origin: string, path: string, base: string = API_BASE): string {
  return `${origin.replace(/^http/, 'ws')}${base}${path}`;
}

/** Rewrites a fetch() input so a leading `/api` path carries the hub base.
 * Only same-origin `/api` string URLs are touched; Request/URL objects,
 * absolute URLs, non-api paths, and already-based paths pass through. */
export function rewriteFetchInput<T>(input: T, base: string = API_BASE): T | string {
  if (!base || typeof input !== 'string') return input;
  if (input.startsWith('/api/') || input === '/api') {
    return `${base}${input}`;
  }
  return input;
}

/**
 * Installs a global fetch wrapper (once) that routes the app's `/api` calls to
 * the current machine's base path in hub mode. Single visible chokepoint so the
 * ~40 fetch call sites stay prefix-agnostic. No-op when not under a hub base.
 */
export function installApiBaseFetch(base: string = API_BASE): void {
  if (!base || typeof window === 'undefined') return;
  const nativeFetch = window.fetch.bind(window);
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) =>
    nativeFetch(rewriteFetchInput(input, base) as RequestInfo | URL, init);
}
