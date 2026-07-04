import type { SessionEvent } from './sessions.types';

/**
 * True when the tail holds an open request the agent is blocked on — either a
 * user-input question or a provider approval — with no matching resolution.
 *
 * A blocked run keeps the session RUNNING (the interactive tool call is still
 * in flight), so this boolean is what separates "actively working" from
 * "waiting on you" for callers that only carry the coarse status field.
 */
export function deriveHasPendingInput(events: SessionEvent[]): boolean {
  const open = new Set<string>();
  for (const event of events) {
    const payload = event.payload as { requestId?: string } | null;
    const requestId = payload?.requestId;
    if (!requestId) continue;
    if (event.type === 'user_input_requested' || event.type === 'provider_request') {
      open.add(requestId);
    }
    if (event.type === 'user_input_resolved' || event.type === 'provider_request_resolved') {
      open.delete(requestId);
    }
  }
  return open.size > 0;
}
