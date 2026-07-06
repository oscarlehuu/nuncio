import { describe, it, expect } from 'bun:test';
import {
  classifyResult,
  createDeltaMappingState,
  mapStreamEvent,
} from '../../../src/agents/providers/claude-agent.helpers';
import type {
  ClaudeResultMessage,
  ClaudeStreamEventMessage,
} from '../../../src/agents/providers/claude-agent.sdk';

/** Mirror of BaseAgentProvider.paragraphBoundary for pure-helper testing. */
function paragraphBoundary(accumulated: string): string {
  if (accumulated.length === 0) return '';
  const trailing = /\n*$/.exec(accumulated)?.[0].length ?? 0;
  return trailing >= 2 ? '' : '\n'.repeat(2 - trailing);
}

function streamEvent(
  uuid: string,
  delta: { type: string; text?: string; thinking?: string },
  index = 0,
): ClaudeStreamEventMessage {
  return { type: 'stream_event', uuid, event: { type: 'content_block_delta', index, delta } };
}

describe('mapStreamEvent', () => {
  it('maps text_delta to assistant_delta and accumulates', () => {
    const state = createDeltaMappingState();
    const first = mapStreamEvent(streamEvent('m1', { type: 'text_delta', text: 'Hello ' }), state, paragraphBoundary);
    const second = mapStreamEvent(streamEvent('m1', { type: 'text_delta', text: 'world' }), state, paragraphBoundary);
    expect(first).toEqual({ type: 'assistant_delta', payload: { delta: 'Hello ' } });
    expect(second).toEqual({ type: 'assistant_delta', payload: { delta: 'world' } });
    expect(state.accumulatedText).toBe('Hello world');
  });

  it('skips empty text deltas', () => {
    const state = createDeltaMappingState();
    expect(mapStreamEvent(streamEvent('m1', { type: 'text_delta', text: '' }), state, paragraphBoundary)).toBeNull();
    expect(state.accumulatedText).toBe('');
  });

  it('maps thinking_delta to thinking_delta with a stable thinkingId', () => {
    const state = createDeltaMappingState();
    const mapped = mapStreamEvent(streamEvent('m1', { type: 'thinking_delta', thinking: 'hmm' }, 2), state, paragraphBoundary);
    expect(mapped).toEqual({ type: 'thinking_delta', payload: { thinkingId: 'm1:2', delta: 'hmm' } });
  });

  it('discriminates thinking before text (thinking arrives first)', () => {
    const state = createDeltaMappingState();
    const thinking = mapStreamEvent(streamEvent('m1', { type: 'thinking_delta', thinking: 't' }), state, paragraphBoundary);
    const text = mapStreamEvent(streamEvent('m1', { type: 'text_delta', text: 'answer' }), state, paragraphBoundary);
    expect(thinking?.type).toBe('thinking_delta');
    expect(text?.type).toBe('assistant_delta');
    expect(state.accumulatedText).toBe('answer');
  });

  it('does NOT insert a separator within a single assistant message id', () => {
    const state = createDeltaMappingState();
    mapStreamEvent(streamEvent('m1', { type: 'text_delta', text: 'end.' }), state, paragraphBoundary);
    const same = mapStreamEvent(streamEvent('m1', { type: 'text_delta', text: 'more' }), state, paragraphBoundary);
    expect((same?.payload as { delta: string }).delta).toBe('more');
  });

  it('inserts a paragraph boundary when the assistant message id changes (glued text)', () => {
    const state = createDeltaMappingState();
    mapStreamEvent(streamEvent('m1', { type: 'text_delta', text: 'end.' }), state, paragraphBoundary);
    const next = mapStreamEvent(streamEvent('m2', { type: 'text_delta', text: 'Start' }), state, paragraphBoundary);
    expect((next?.payload as { delta: string }).delta).toBe('\n\nStart');
    expect(state.accumulatedText).toBe('end.\n\nStart');
  });

  it('maps a tool_use content_block_start to tool_start', () => {
    const state = createDeltaMappingState();
    const mapped = mapStreamEvent(
      {
        type: 'stream_event',
        uuid: 'm1',
        event: {
          type: 'content_block_start',
          content_block: { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } },
        },
      },
      state,
      paragraphBoundary,
    );
    expect(mapped).toEqual({
      type: 'tool_start',
      payload: { callId: 'toolu_1', tool: 'Bash', input: { command: 'ls' } },
    });
  });

  it('ignores non-mapped stream events (message_start, stop, unknown deltas)', () => {
    const state = createDeltaMappingState();
    expect(
      mapStreamEvent({ type: 'stream_event', uuid: 'm1', event: { type: 'message_start' } }, state, paragraphBoundary),
    ).toBeNull();
    expect(
      mapStreamEvent(streamEvent('m1', { type: 'signature_delta' }), state, paragraphBoundary),
    ).toBeNull();
  });
});

describe('classifyResult', () => {
  function result(over: Partial<ClaudeResultMessage>): ClaudeResultMessage {
    return { type: 'result', subtype: 'success', ...over };
  }

  it('classifies success and uses result.result as authoritative text', () => {
    expect(classifyResult(result({ subtype: 'success', result: 'Final.' }), 'partial')).toEqual({
      kind: 'success',
      text: 'Final.',
    });
  });

  it('falls back to accumulated text when success result is empty', () => {
    expect(classifyResult(result({ subtype: 'success', result: '' }), 'accum')).toEqual({
      kind: 'success',
      text: 'accum',
    });
  });

  it('classifies aborted_tools as an interrupt, not an error', () => {
    const classified = classifyResult(
      result({ subtype: 'error_during_execution', terminal_reason: 'aborted_tools', errors: [] }),
      '',
    );
    expect(classified.kind).toBe('interrupted');
  });

  it('classifies aborted_streaming as an interrupt', () => {
    const classified = classifyResult(
      result({ subtype: 'error_during_execution', terminal_reason: 'aborted_streaming', errors: [] }),
      '',
    );
    expect(classified.kind).toBe('interrupted');
  });

  it('classifies "No conversation found" as cannot-resume', () => {
    const classified = classifyResult(
      result({
        subtype: 'error_during_execution',
        errors: ['No conversation found with session ID: abc'],
      }),
      '',
    );
    expect(classified).toEqual({
      kind: 'cannot-resume',
      message: 'No conversation found with session ID: abc',
    });
  });

  it('classifies other error subtypes as errors', () => {
    const classified = classifyResult(
      result({ subtype: 'error_max_turns', errors: ['exceeded max turns'] }),
      '',
    );
    expect(classified).toEqual({ kind: 'error', message: 'exceeded max turns' });
  });

  it('an error result without errors[] still yields a non-empty error message', () => {
    const classified = classifyResult(result({ subtype: 'error_max_budget_usd', errors: [] }), '');
    expect(classified.kind).toBe('error');
    expect((classified as { message: string }).message).toBe('error_max_budget_usd');
  });
});
