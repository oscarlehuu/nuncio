import { deviceBearer } from '@nuncio/core/pairing-client';
import { saveConnection, type ConnectionConfig, type KeyValueStore } from './connection-store';

/**
 * Rotates the device secret once per app launch (refresh-token style). The order
 * is the invariant: the freshly minted secret is PERSISTED to secure store
 * before it is swapped into the in-memory header. If persistence fails we keep
 * the old secret — the server holds one previous generation valid, so a
 * mid-rotation crash never forces a re-scan. A 401 means the device was revoked;
 * the caller must clear the connection and return to pairing.
 */
export type RotateOutcome = 'rotated' | 'revoked' | 'skipped' | 'kept-old';

export interface RotateDeps {
  config: ConnectionConfig;
  store: KeyValueStore;
  fetchImpl: (input: string, init?: RequestInit) => Promise<Response>;
  /** Swap the new secret into the live api/relay header after it is persisted. */
  applySecret: (secret: string) => void;
}

export async function rotateDeviceSecret(deps: RotateDeps): Promise<RotateOutcome> {
  const { config, store, fetchImpl, applySecret } = deps;
  // Legacy (global-token) connections have no per-device secret to rotate.
  if (!config.deviceId || !config.deviceSecret) return 'skipped';

  let res: Response;
  try {
    res = await fetchImpl(`${config.serverUrl}/api/devices/rotate`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${deviceBearer(config.deviceId, config.deviceSecret)}` },
    });
  } catch {
    // Offline / unreachable — the old secret is still valid; try again next launch.
    return 'kept-old';
  }

  if (res.status === 401) return 'revoked';
  if (!res.ok) return 'kept-old';

  const body = (await res.json().catch(() => null)) as { deviceSecret?: unknown } | null;
  if (!body || typeof body.deviceSecret !== 'string') return 'kept-old';
  const newSecret = body.deviceSecret;

  try {
    await saveConnection(store, { ...config, deviceSecret: newSecret });
  } catch {
    // Persist failed — do NOT swap in-memory, or a crash would strand a secret
    // that was never written to disk. Server grace keeps the old one working.
    return 'kept-old';
  }
  applySecret(newSecret);
  return 'rotated';
}
