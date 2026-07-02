import type { SessionEvent } from './sessions.types';

export type SessionEventHook = (sessionId: string, event: SessionEvent) => void;

const hooks = new Set<SessionEventHook>();

/**
 * Observer seam on the persisted event log — every appended event flows
 * through here exactly once (EventsRepository.append). Hooks must never
 * throw into the append path; failures are swallowed.
 */
export function registerSessionEventHook(hook: SessionEventHook): () => void {
  hooks.add(hook);
  return () => hooks.delete(hook);
}

export function notifySessionEventHooks(sessionId: string, event: SessionEvent): void {
  for (const hook of hooks) {
    try {
      hook(sessionId, event);
    } catch {
      // Notification side-channels never break event persistence.
    }
  }
}
