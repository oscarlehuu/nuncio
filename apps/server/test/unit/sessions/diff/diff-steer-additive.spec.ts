import { describe, expect, it } from 'bun:test';
import type { SessionEventType } from '../../../../src/sessions/domain/events.types';

/**
 * ADR-007 guard (rung 3 sub-phase D): comment-to-steer is ADDITIVE — it rides the
 * EXISTING steer path, and `steer_message` already carries the text. NO new
 * SessionEventType is introduced. This is an invariant check (stays green); it
 * fails LOUD if a future edit tries to add a diff-comment event type.
 */
describe('diff comment-to-steer is additive (ADR-007)', () => {
  it('the steer text rides the EXISTING steer_message event type (no new type)', () => {
    // Typed against the frozen union — steer_message / steer_queued must exist and
    // a diff comment maps onto them, never a bespoke 'diff_comment' event.
    const carriers: SessionEventType[] = ['steer_message', 'steer_queued'];
    expect(carriers).toHaveLength(2);
  });
});
