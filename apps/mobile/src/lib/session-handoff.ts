import type { SessionStatus } from '@nuncio/core/api';
import type { ModelProvider } from '@nuncio/core/model-providers';

/**
 * A session can hand its work to another engine only once it has settled — a
 * live run is still producing the very timeline the target engine would inherit.
 * Mirrors the server-side guard and the web `canHandoff` derivation.
 */
export function canHandoffSession(
  status: SessionStatus | null | undefined,
): boolean {
  return status === 'IDLE' || status === 'PAUSED' || status === 'ERROR';
}

/**
 * Eligible handoff engines: every available provider that is not the session's
 * current one. Unavailable providers (missing auth / not installed) are dropped,
 * matching the target-set the server will accept.
 */
export function handoffTargets(
  providers: ModelProvider[],
  currentProviderId: string | null | undefined,
): ModelProvider[] {
  return providers.filter(
    (provider) => provider.unavailable !== true && provider.id !== currentProviderId,
  );
}
