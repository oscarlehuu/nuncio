import { configureApiClient } from '@nuncio/core/http';
import type { ConnectionConfig } from './connection-store';

/**
 * Points every @nuncio/core API call at the paired server. Mobile always
 * authenticates with the Bearer header — unlike browsers, React Native can
 * set it on both fetch and WebSocket, so no cookie exchange is needed.
 */
export function applyConnection(config: ConnectionConfig): void {
  configureApiClient({
    baseUrl: config.serverUrl,
    headers: (): Record<string, string> =>
      config.token ? { Authorization: `Bearer ${config.token}` } : {},
  });
}
