import {
  authHeader,
  clearConnection,
  loadConnection,
  saveConnection,
  type ConnectionConfig,
  type KeyValueStore,
} from './connection-store';

export type ManualPairingResult =
  | { kind: 'connected' }
  | { kind: 'unauthorized' }
  | { kind: 'server-error'; status: number }
  | { kind: 'network-error' }
  | { kind: 'persist-error' };

export interface ManualPairingDependencies {
  fetchImpl: (input: string, init?: RequestInit) => Promise<Response>;
  store: KeyValueStore;
  apply: (config: ConnectionConfig) => void;
}

async function restorePreviousConnection(
  store: KeyValueStore,
  previous: ConnectionConfig | null,
): Promise<void> {
  if (previous) {
    await saveConnection(store, previous);
  } else {
    await clearConnection(store);
  }
}

/**
 * Pure orchestration seam for manual pairing. Validation is performed with the
 * candidate URL/header directly; the global client is the final commit after a
 * durable save. If a store reports failure after a partial write, the previous
 * value is restored before returning the persistence error.
 */
export async function connectManualCandidate(
  config: ConnectionConfig,
  dependencies: ManualPairingDependencies,
): Promise<ManualPairingResult> {
  let response: Response;
  try {
    response = await dependencies.fetchImpl(`${config.serverUrl}/api/auth/status`, {
      headers: authHeader(config),
    });
  } catch {
    return { kind: 'network-error' };
  }

  if (response.status === 401 || response.status === 403) {
    return { kind: 'unauthorized' };
  }
  if (!response.ok) {
    return { kind: 'server-error', status: response.status };
  }

  let authStatus: unknown;
  try {
    authStatus = await response.json();
  } catch {
    return { kind: 'server-error', status: response.status };
  }
  if (
    typeof authStatus !== 'object' ||
    authStatus === null ||
    !('authenticated' in authStatus)
  ) {
    return { kind: 'server-error', status: response.status };
  }
  if ((authStatus as { authenticated: unknown }).authenticated !== true) {
    return { kind: 'unauthorized' };
  }

  let previous: ConnectionConfig | null;
  try {
    previous = await loadConnection(dependencies.store);
  } catch {
    return { kind: 'persist-error' };
  }

  try {
    await saveConnection(dependencies.store, config);
    dependencies.apply(config);
  } catch {
    try {
      await restorePreviousConnection(dependencies.store, previous);
    } catch {
      // The store is still unavailable; the live client remains untouched.
    }
    return { kind: 'persist-error' };
  }
  return { kind: 'connected' };
}
