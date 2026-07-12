import { describe, expect, it } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { SessionEvent } from './api';
import { buildTranscriptBlocks } from './transcript-build-blocks';
import { useTranscriptBlocks } from './use-transcript-blocks';

function ev(seq: number, type: string, payload: Record<string, unknown>): SessionEvent {
  return { seq, type, payload, createdAt: seq };
}

/**
 * Feeds `events` into the hook one event at a time (simulating streaming
 * token-by-token growth) and asserts that after each append, the hook's
 * output matches a fresh `buildTranscriptBlocks` over the same prefix.
 */
function assertIncrementalMatchesBatch(events: SessionEvent[]): void {
  const { result, rerender } = renderHook(
    ({ events: e }: { events: SessionEvent[] }) => useTranscriptBlocks(e),
    { initialProps: { events: [] as SessionEvent[] } },
  );

  for (let k = 1; k <= events.length; k++) {
    const prefix = events.slice(0, k);
    rerender({ events: prefix });
    const expected = buildTranscriptBlocks(prefix);
    expect(result.current).toEqual(expected);
  }
}

describe('useTranscriptBlocks incremental equivalence', () => {
  it('matches batch parse for plain user/assistant delta streaming', () => {
    assertIncrementalMatchesBatch([
      ev(1, 'user_message', { text: 'hi there' }),
      ev(2, 'assistant_delta', { delta: 'Hel' }),
      ev(3, 'assistant_delta', { delta: 'lo ' }),
      ev(4, 'assistant_delta', { delta: 'world' }),
      ev(5, 'assistant_message', { text: 'Hello world' }),
    ]);
  });

  it('matches batch parse for thinking_start/delta/message interleaved', () => {
    assertIncrementalMatchesBatch([
      ev(1, 'user_message', { text: 'question' }),
      ev(2, 'thinking_start', { thinkingId: 't1' }),
      ev(3, 'thinking_delta', { delta: 'hm' }),
      ev(4, 'thinking_delta', { delta: 'm...' }),
      ev(5, 'thinking_message', { text: 'hmm...' }),
      ev(6, 'assistant_delta', { delta: 'Answer' }),
      ev(7, 'assistant_message', { text: 'Answer' }),
    ]);
  });

  it('matches batch parse for tool_start then later tool_end (reach-back mutation)', () => {
    assertIncrementalMatchesBatch([
      ev(1, 'user_message', { text: 'run it' }),
      ev(2, 'tool_start', { callId: 'c1', tool: 'bash', input: { cmd: 'ls' } }),
      ev(3, 'assistant_delta', { delta: 'working' }),
      ev(4, 'tool_end', { callId: 'c1', tool: 'bash', output: 'ok' }),
      ev(5, 'assistant_message', { text: 'Done' }),
    ]);
  });

  it('matches batch parse for multiple concurrent tools', () => {
    assertIncrementalMatchesBatch([
      ev(1, 'user_message', { text: 'run both' }),
      ev(2, 'tool_start', { callId: 'c1', tool: 'bash', input: { cmd: 'ls' } }),
      ev(3, 'tool_start', { callId: 'c2', tool: 'read', input: { path: '/x.ts' } }),
      ev(4, 'tool_end', { callId: 'c2', tool: 'read', output: 'contents' }),
      ev(5, 'tool_end', { callId: 'c1', tool: 'bash', output: 'ok' }),
      ev(6, 'assistant_message', { text: 'Both done' }),
    ]);
  });

  it('matches batch parse for user_input_requested then resolved', () => {
    const questions = [{ id: 'q1', prompt: 'Pick', options: [{ id: 'a', label: 'A' }] }];
    assertIncrementalMatchesBatch([
      ev(1, 'user_message', { text: 'need a choice' }),
      ev(2, 'user_input_requested', { requestId: 'r1', title: 'Title', questions }),
      ev(3, 'user_input_resolved', { requestId: 'r1', resolvedBy: 'user' }),
      ev(4, 'assistant_message', { text: 'Got it' }),
    ]);
  });

  it('matches batch parse for interactive tool_start then tool_end', () => {
    const questions = [{ id: 'q1', prompt: 'Pick', options: [{ id: 'a', label: 'A' }] }];
    assertIncrementalMatchesBatch([
      ev(1, 'tool_start', {
        callId: 'c1',
        tool: 'askquestion',
        input: { title: 'Title', questions },
      }),
      ev(2, 'tool_end', { callId: 'c1', tool: 'askquestion', isError: false }),
      ev(3, 'assistant_message', { text: 'Thanks' }),
    ]);
  });

  it('matches batch parse for provider_request then resolved', () => {
    assertIncrementalMatchesBatch([
      ev(1, 'user_message', { text: 'approve?' }),
      ev(2, 'provider_request', { requestId: 'p1', provider: 'openai', method: 'chat' }),
      ev(3, 'provider_request_resolved', { requestId: 'p1', decision: 'approve' }),
      ev(4, 'assistant_message', { text: 'Approved' }),
    ]);
  });

  it('matches batch parse for provider_request_resolved with no prior request', () => {
    assertIncrementalMatchesBatch([
      ev(1, 'user_message', { text: 'hmm' }),
      ev(2, 'provider_request_resolved', { requestId: 'p2', decision: 'deny' }),
      ev(3, 'assistant_message', { text: 'ok' }),
    ]);
  });

  it('matches batch parse while folding before and after evidence', () => {
    assertIncrementalMatchesBatch([
      ev(1, 'evidence_captured', {
        beforeRef: { id: 'a'.repeat(32), mimeType: 'image/png' },
        route: '/app', viewport: { w: 1440, h: 900 }, workspaceHead: 'head-a',
      }),
      ev(2, 'evidence_captured', {
        afterRef: { id: 'b'.repeat(32), mimeType: 'image/png' },
        route: '/app', viewport: { w: 1440, h: 900 }, workspaceHead: 'head-b',
      }),
    ]);
  });

  it('matches batch parse for steer_message rendering', () => {
    assertIncrementalMatchesBatch([
      ev(1, 'user_message', { text: 'do X' }),
      ev(2, 'assistant_delta', { delta: 'working' }),
      ev(3, 'steer_message', { text: 'actually do Y' }),
      ev(4, 'assistant_message', { text: 'Doing Y' }),
    ]);
  });

  it('matches batch parse for a full mixed session ending in a streaming tail', () => {
    const events = [
      ev(1, 'user_message', { text: 'turn 1' }),
      ev(2, 'thinking_start', { thinkingId: 't1' }),
      ev(3, 'thinking_delta', { delta: 'thinking...' }),
      ev(4, 'thinking_message', { text: 'thinking...' }),
      ev(5, 'tool_start', { callId: 'c1', tool: 'bash', input: { cmd: 'ls' } }),
      ev(6, 'tool_end', { callId: 'c1', tool: 'bash', output: 'ok' }),
      ev(7, 'assistant_message', { text: 'turn 1 response' }),
      ev(8, 'user_message', { text: 'turn 2' }),
      ev(9, 'tool_start', { callId: 'c2', tool: 'read', input: { path: '/y.ts' } }),
      ev(10, 'tool_end', { callId: 'c2', tool: 'read', output: 'y contents' }),
      ev(11, 'assistant_message', { text: 'turn 2 response' }),
      ev(12, 'user_message', { text: 'turn 3' }),
      ev(13, 'assistant_delta', { delta: 'partial resp' }),
      ev(14, 'assistant_delta', { delta: 'onse still going' }),
    ];
    assertIncrementalMatchesBatch(events);

    const finalBlocks = buildTranscriptBlocks(events);
    expect(finalBlocks.at(-1)).toMatchObject({
      kind: 'assistant',
      text: 'partial response still going',
      streaming: true,
    });
  });

  it('resets on session switch (non-extending events array)', () => {
    const { result, rerender } = renderHook(
      ({ events: e }: { events: SessionEvent[] }) => useTranscriptBlocks(e),
      { initialProps: { events: [] as SessionEvent[] } },
    );

    const sessionA = [
      ev(1, 'user_message', { text: 'session A msg 1' }),
      ev(2, 'assistant_message', { text: 'session A reply 1' }),
      ev(3, 'user_message', { text: 'session A msg 2' }),
      ev(4, 'assistant_delta', { delta: 'streaming...' }),
    ];
    for (let k = 1; k <= sessionA.length; k++) {
      rerender({ events: sessionA.slice(0, k) });
    }
    expect(result.current).toEqual(buildTranscriptBlocks(sessionA));

    // Different session entirely: different seq numbers/content, shorter.
    const sessionB = [
      ev(101, 'user_message', { text: 'session B msg 1' }),
      ev(102, 'assistant_message', { text: 'session B reply 1' }),
    ];
    rerender({ events: sessionB });
    expect(result.current).toEqual(buildTranscriptBlocks(sessionB));
  });

  it('resets when events array shrinks', () => {
    const { result, rerender } = renderHook(
      ({ events: e }: { events: SessionEvent[] }) => useTranscriptBlocks(e),
      { initialProps: { events: [] as SessionEvent[] } },
    );

    const full = [
      ev(1, 'user_message', { text: 'msg 1' }),
      ev(2, 'assistant_message', { text: 'reply 1' }),
      ev(3, 'user_message', { text: 'msg 2' }),
      ev(4, 'assistant_message', { text: 'reply 2' }),
    ];
    for (let k = 1; k <= full.length; k++) {
      rerender({ events: full.slice(0, k) });
    }

    const shrunk = full.slice(0, 2);
    rerender({ events: shrunk });
    expect(result.current).toEqual(buildTranscriptBlocks(shrunk));
  });
});
