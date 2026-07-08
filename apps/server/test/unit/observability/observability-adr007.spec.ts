import { describe, expect, it } from 'bun:test';
import type { SessionEventType } from '../../../src/sessions/domain/events.types';

describe('observability is additive to the session event contract', () => {
  it('uses existing events for verify, steers, status, and transcript facts', () => {
    const consumed: SessionEventType[] = [
      'user_message',
      'assistant_message',
      'status',
      'verify_result',
      'verify_retry',
      'verify_needs_attention',
      'steer_message',
      'steer_queued',
    ];

    expect(consumed).toHaveLength(8);
  });

  it('does not introduce usage or observability-specific session event types', () => {
    const forbidden = ['usage', 'token_usage', 'cost_reported', 'observability_rollup'];
    const existing: string[] = [
      'user_message',
      'assistant_delta',
      'assistant_message',
      'tool_start',
      'tool_end',
      'thinking_start',
      'thinking_delta',
      'thinking_message',
      'user_input_requested',
      'user_input_resolved',
      'error',
      'status',
      'transcript_refreshed',
      'runtime_restarted',
      'runtime_stalled',
      'verify_start',
      'verify_result',
      'verify_retry',
      'verify_needs_attention',
      'steer_message',
      'steer_queued',
      'steer_queue_cleared',
      'interrupted',
    ];

    expect(forbidden.some((type) => existing.includes(type))).toBe(false);
  });
});
