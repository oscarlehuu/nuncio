import { saveConnection, type ConnectionConfig, type KeyValueStore } from './connection-store';

/**
 * Persist a freshly-obtained connection to secure store BEFORE swapping it into
 * the live api client. The QR pairing secret is single-use and returned exactly
 * once, so a swap-before-persist that then failed to write (or crashed) would
 * lose the secret and force the user to regenerate the QR. Persisting first
 * makes the write the commit point: only on a successful save do we apply.
 *
 * Returns 'saved' when the config is written and applied, or 'save-failed' when
 * the write threw — in which case `apply` is never called and the caller stays
 * on the pairing screen with an error.
 */
export type PersistOutcome = 'saved' | 'save-failed';

export async function persistThenApply(
  store: KeyValueStore,
  config: ConnectionConfig,
  apply: (config: ConnectionConfig) => void,
): Promise<PersistOutcome> {
  try {
    await saveConnection(store, config);
  } catch {
    return 'save-failed';
  }
  apply(config);
  return 'saved';
}
