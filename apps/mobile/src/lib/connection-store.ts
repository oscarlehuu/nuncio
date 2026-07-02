/**
 * Pairing state: which Nuncio server this phone talks to and with which
 * token. The serverUrl keeps its path component so a hub machine base
 * (https://hub.tailnet.ts.net/m/studio) pairs exactly like a direct server.
 */
export interface ConnectionConfig {
  serverUrl: string;
  token: string | null;
}

export interface KeyValueStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

const CONNECTION_KEY = 'nuncio.connection';

export function normalizeServerUrl(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(withScheme);
    const path = url.pathname.replace(/\/+$/, '');
    return `${url.origin}${path}`;
  } catch {
    return null;
  }
}

/** ws(s):// URL of the session relay for a paired server. */
export function relayUrlFor(serverUrl: string): string {
  return `${serverUrl.replace(/^http/, 'ws')}/api/sessions/ws`;
}

export async function loadConnection(store: KeyValueStore): Promise<ConnectionConfig | null> {
  const raw = await store.get(CONNECTION_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<ConnectionConfig>;
    if (typeof parsed.serverUrl !== 'string' || !parsed.serverUrl) return null;
    return { serverUrl: parsed.serverUrl, token: typeof parsed.token === 'string' ? parsed.token : null };
  } catch {
    return null;
  }
}

export async function saveConnection(store: KeyValueStore, config: ConnectionConfig): Promise<void> {
  await store.set(CONNECTION_KEY, JSON.stringify(config));
}

export async function clearConnection(store: KeyValueStore): Promise<void> {
  await store.delete(CONNECTION_KEY);
}
