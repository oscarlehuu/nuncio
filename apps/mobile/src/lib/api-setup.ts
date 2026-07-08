import { configureApiClient } from '@nuncio/core/http';
import { authHeader, type ConnectionConfig } from './connection-store';

let active: ConnectionConfig | null = null;

/**
 * Points every @nuncio/core API call at the paired server. Mobile always
 * authenticates with the Bearer header — unlike browsers, React Native can
 * set it on both fetch and WebSocket, so no cookie exchange is needed. The
 * header is read from `active` at call time (not captured) so rotating the
 * device secret in place takes effect on the next request without reconfiguring.
 */
export function applyConnection(config: ConnectionConfig): void {
  active = config;
  configureApiClient({
    baseUrl: config.serverUrl,
    headers: (): Record<string, string> => (active ? authHeader(active) : {}),
  });
}

/**
 * Swaps the in-memory device secret without touching persistence or the base
 * URL. Rotation persists the new secret to secure store first, then calls this
 * so the next authed request carries the fresh credential.
 */
export function updateActiveSecret(deviceSecret: string): void {
  if (active) active = { ...active, deviceSecret };
}

export function activeConnection(): ConnectionConfig | null {
  return active;
}
