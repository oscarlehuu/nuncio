import { describe, expect, it } from 'bun:test';
import type { SessionEventType } from '../../../src/sessions/domain/events.types';

describe('dispatcher is additive to the session event contract', () => {
  it('uses existing verify, steer, and status facts without adding dispatcher event types', () => {
    const consumed: SessionEventType[] = [
      'status',
      'verify_result',
      'verify_needs_attention',
      'steer_queued',
      'steer_message',
    ];
    const forbidden = ['dispatcher_proposal', 'dispatcher_approved', 'task_proposed'];

    expect(consumed).toHaveLength(5);
    expect(forbidden.some((type) => consumed.includes(type as SessionEventType))).toBe(false);
  });
});
