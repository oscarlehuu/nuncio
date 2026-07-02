/**
 * Transport seam for every REST call in this package. The web app runs
 * same-origin (base '', hub base handled by its window.fetch patch); native
 * clients inject an absolute base URL plus auth headers instead. fetch is
 * resolved lazily via `globalThis` so test stubs and the web hub-base patch
 * still intercept calls.
 */
export interface ApiClientConfig {
  baseUrl: string;
  headers: () => Record<string, string>;
  fetchImpl: (...args: [string, RequestInit?]) => Promise<Response>;
}

const config: ApiClientConfig = {
  baseUrl: '',
  headers: () => ({}),
  fetchImpl: (...args) => globalThis.fetch(...args),
};

export function configureApiClient(overrides: Partial<ApiClientConfig>): void {
  Object.assign(config, overrides);
}

export function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  const extra = config.headers();
  const merged = Object.keys(extra).length
    ? {
        ...init,
        headers: { ...extra, ...(init?.headers as Record<string, string> | undefined) },
      }
    : init;
  // Preserve the exact call shape of a bare fetch(url) — callers and their
  // specs distinguish (url) from (url, undefined).
  return merged === undefined
    ? config.fetchImpl(config.baseUrl + path)
    : config.fetchImpl(config.baseUrl + path, merged);
}
