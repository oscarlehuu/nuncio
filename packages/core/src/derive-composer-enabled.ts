import type { SessionStatus } from './api';

export interface ComposerEnabledInput {
  status: SessionStatus;
  steering: boolean;
  lifecycleBusy: boolean;
  hasPendingUserInput: boolean;
}

export interface ComposerEnabledResult {
  enabled: boolean;
  reason?: string;
}

/**
 * Whether the session composer accepts input. Mirrors session-detail steer gating:
 * archived sessions, in-flight steers, lifecycle actions, and unresolved
 * AskQuestion prompts disable the composer.
 *
 * RUNNING alone does not disable — mid-run steer is gated separately via
 * `supportsSteerWhileRunning` on the session, not here.
 */
export function deriveComposerEnabled(input: ComposerEnabledInput): ComposerEnabledResult {
  if (input.status === 'ARCHIVED') {
    return { enabled: false, reason: 'archived' };
  }
  if (input.steering) {
    return { enabled: false, reason: 'steering' };
  }
  if (input.lifecycleBusy) {
    return { enabled: false, reason: 'lifecycle_busy' };
  }
  if (input.hasPendingUserInput) {
    return { enabled: false, reason: 'pending_user_input' };
  }
  return { enabled: true };
}
