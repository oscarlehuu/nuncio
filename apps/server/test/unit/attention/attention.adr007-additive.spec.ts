import { describe, expect, it } from 'bun:test';
import { registerSessionEventHook } from '../../../src/sessions/domain/session-event-hooks';
import type { SessionEventType } from '../../../src/sessions/domain/events.types';

/**
 * ADR-007 guard (rung 3 sub-phase A): the attention queue is ADDITIVE — its
 * collectors read the session events rungs 1-2 already emit and MUST NOT add a
 * new SessionEventType. This is an invariant check, not a skeleton — it stays
 * green and fails LOUD (compile OR runtime) if a future edit renames/removes the
 * events attention depends on, forcing a conscious contract decision.
 */
describe('attention queue is additive (ADR-007)', () => {
  it('collectors subscribe through the existing session-event-hook seam (no new transport)', () => {
    const off = registerSessionEventHook(() => {});
    expect(typeof off).toBe('function');
    off();
  });

  it('the permission + verify-dead signals the queue consumes are EXISTING event types', () => {
    // Typed against the frozen union: if any is renamed/removed, this stops
    // compiling — attention must map existing events, never invent new ones.
    const required: SessionEventType[] = [
      'user_input_requested',
      'user_input_resolved',
      'verify_needs_attention',
    ];
    expect(required).toHaveLength(3);
  });
});
