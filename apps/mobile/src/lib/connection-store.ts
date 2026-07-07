import { deviceBearer } from '@nuncio/core/pairing-client';

/**
 * Pairing state: which Nuncio server this phone talks to and with which
 * credential. `serverUrl` keeps its path component so a hub machine base
 * (https://hub.tailnet.ts.net/m/studio) pairs exactly like a direct server.
 *
 * Two credential shapes coexist. Manual pairing stores a `token` (the global
 * server token). QR pairing stores a per-device `deviceId`/`deviceSecret` (the
 * `nd1.` bearer) plus the scanned `candidateUrls` so the connection manager can
 * re-probe when the network changes. Both device fields are always written and
 * read together — one without the other is meaningless.
 */
export interface ConnectionConfig {
  serverUrl: string;
  token: string | null;
  deviceId?: string;
  deviceSecret?: string;
  candidateUrls?: string[];
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

/**
 * The Authorization header value for a config: the per-device `nd1.` bearer when
 * device credentials are present, otherwise the legacy global token, otherwise
 * none. Both fetch (api-setup) and the WS factory route through this so REST and
 * the relay always send the same credential.
 */
export function authHeader(config: ConnectionConfig): Record<string, string> {
  if (config.deviceId && config.deviceSecret) {
    return { Authorization: `Bearer ${deviceBearer(config.deviceId, config.deviceSecret)}` };
  }
  return config.token ? { Authorization: `Bearer ${config.token}` } : {};
}

function readCandidateUrls(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const urls = value.filter((u): u is string => typeof u === 'string');
  return urls.length ? urls : undefined;
}

export async function loadConnection(store: KeyValueStore): Promise<ConnectionConfig | null> {
  const raw = await store.get(CONNECTION_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<ConnectionConfig>;
    if (typeof parsed.serverUrl !== 'string' || !parsed.serverUrl) return null;
    const config: ConnectionConfig = {
      serverUrl: parsed.serverUrl,
      token: typeof parsed.token === 'string' ? parsed.token : null,
    };
    // Device credentials are only honored as a pair — a half-written credential
    // (id without secret) falls back to the legacy token path rather than
    // producing an unusable `nd1.<id>.undefined` bearer.
    if (typeof parsed.deviceId === 'string' && typeof parsed.deviceSecret === 'string') {
      config.deviceId = parsed.deviceId;
      config.deviceSecret = parsed.deviceSecret;
    }
    const candidateUrls = readCandidateUrls(parsed.candidateUrls);
    if (candidateUrls) config.candidateUrls = candidateUrls;
    return config;
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
