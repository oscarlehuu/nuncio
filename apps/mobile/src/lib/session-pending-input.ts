import type { Session, SessionEvent } from '@nuncio/core/api';

/** Latest status event in the tail wins over the (possibly stale) session row. */
export function latestSessionStatus(events: SessionEvent[]): Session['status'] | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event?.type !== 'status') continue;
    const value = (event.payload as { status?: Session['status'] })?.status;
    if (value) return value;
  }
  return undefined;
}

/** True when the event tail holds an open user-input or provider-approval request. */
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

/** Mirrors server pendingInput: only a live RUNNING session can block on you. */
export function deriveNeedsInput(
  events: SessionEvent[],
  sessionStatus: Session['status'] | undefined,
  sessionPendingInput: boolean | undefined,
): boolean {
  const status = latestSessionStatus(events) ?? sessionStatus;
  if (status !== 'RUNNING') return false;
  if (events.length > 0) return deriveHasPendingInput(events);
  return sessionPendingInput ?? false;
}
