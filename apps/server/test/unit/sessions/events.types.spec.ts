import {
  DEFAULT_PAYLOAD_MAX_BYTES,
  isThinkingDeltaEvent,
  isToolEndEvent,
  isToolStartEvent,
  isUserInputRequestedEvent,
  isUserInputResolvedEvent,
  truncatePayload,
} from '../../../src/sessions/domain/events.types';

describe('events.types', () => {
  describe('truncatePayload', () => {
    it('returns small values unchanged', () => {
      const input = { path: '/foo.ts' };
      expect(truncatePayload(input)).toEqual({ value: input, truncated: false });
    });

    it('truncates oversized payloads with preview', () => {
      const big = 'x'.repeat(DEFAULT_PAYLOAD_MAX_BYTES + 100);
      const result = truncatePayload(big);
      expect(result.truncated).toBe(true);
      const value = result.value as { truncated: boolean; preview: string };
      expect(value.truncated).toBe(true);
      expect(value.preview.length).toBeLessThanOrEqual(DEFAULT_PAYLOAD_MAX_BYTES);
    });

    it('passes through undefined and null', () => {
      expect(truncatePayload(undefined)).toEqual({ value: undefined, truncated: false });
      expect(truncatePayload(null)).toEqual({ value: null, truncated: false });
    });
  });

  describe('type guards', () => {
    it('isToolStartEvent matches tool_start with tool field', () => {
      expect(isToolStartEvent({ type: 'tool_start', payload: { tool: 'Read' } })).toBe(true);
      expect(isToolStartEvent({ type: 'tool_end', payload: { tool: 'Read' } })).toBe(false);
      expect(isToolStartEvent({ type: 'tool_start', payload: {} })).toBe(false);
    });

    it('isToolEndEvent matches tool_end with tool field', () => {
      expect(isToolEndEvent({ type: 'tool_end', payload: { tool: 'bash', isError: false } })).toBe(true);
      expect(isToolEndEvent({ type: 'tool_start', payload: { tool: 'bash' } })).toBe(false);
    });

    it('isThinkingDeltaEvent matches thinking_delta with delta', () => {
      expect(isThinkingDeltaEvent({ type: 'thinking_delta', payload: { delta: 'hmm' } })).toBe(true);
      expect(isThinkingDeltaEvent({ type: 'assistant_delta', payload: { delta: 'hi' } })).toBe(false);
    });

    it('isUserInputRequestedEvent matches user_input_requested with requestId + questions', () => {
      expect(
        isUserInputRequestedEvent({
          type: 'user_input_requested',
          payload: { requestId: 'r1', questions: [{ id: 'q1', prompt: 'p', options: [] }] },
        }),
      ).toBe(true);
      expect(isUserInputRequestedEvent({ type: 'user_input_resolved', payload: {} })).toBe(false);
    });

    it('isUserInputResolvedEvent matches user_input_resolved with requestId + resolvedBy', () => {
      expect(
        isUserInputResolvedEvent({
          type: 'user_input_resolved',
          payload: { requestId: 'r1', resolvedBy: 'user' },
        }),
      ).toBe(true);
      expect(isUserInputResolvedEvent({ type: 'user_input_requested', payload: {} })).toBe(false);
    });
  });
});
