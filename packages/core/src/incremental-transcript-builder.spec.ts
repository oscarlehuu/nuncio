import { describe, expect, it } from 'vitest';
import type { SessionEvent } from './api';
import { IncrementalTranscriptBuilder } from './incremental-transcript-builder';
import { buildTranscriptBlocks, type TranscriptBlock } from './transcript-build-blocks';

type Builder = {
  update: (events: SessionEvent[]) => TranscriptBlock[];
  reset: () => void;
};

type BuilderConstructor = new (onEventProcessed?: (event: SessionEvent) => void) => Builder;

function createBuilder(onEventProcessed?: (event: SessionEvent) => void): Builder {
  const BuilderClass = IncrementalTranscriptBuilder as unknown as BuilderConstructor;
  return new BuilderClass(onEventProcessed);
}

function event(seq: number, type: string, payload: Record<string, unknown>): SessionEvent {
  return { seq, type, payload, createdAt: seq };
}

const questions = [{ id: 'q1', prompt: 'Pick', options: [{ id: 'a', label: 'A' }] }];

const equivalenceCases: Array<[string, SessionEvent[]]> = [
  ['plain user and assistant delta streaming', [
    event(1, 'user_message', { text: 'hi there' }),
    event(2, 'assistant_delta', { delta: 'Hel' }),
    event(3, 'assistant_delta', { delta: 'lo ' }),
    event(4, 'assistant_delta', { delta: 'world' }),
    event(5, 'assistant_message', { text: 'Hello world' }),
  ]],
  ['interleaved thinking', [
    event(1, 'user_message', { text: 'question' }),
    event(2, 'thinking_start', { thinkingId: 't1' }),
    event(3, 'thinking_delta', { delta: 'hm' }),
    event(4, 'thinking_delta', { delta: 'm...' }),
    event(5, 'thinking_message', { text: 'hmm...' }),
    event(6, 'assistant_delta', { delta: 'Answer' }),
    event(7, 'assistant_message', { text: 'Answer' }),
  ]],
  ['tool reach-back resolution', [
    event(1, 'user_message', { text: 'run it' }),
    event(2, 'tool_start', { callId: 'c1', tool: 'bash', input: { command: 'ls' } }),
    event(3, 'assistant_delta', { delta: 'working' }),
    event(4, 'tool_end', { callId: 'c1', tool: 'bash', output: 'ok' }),
    event(5, 'assistant_message', { text: 'Done' }),
  ]],
  ['multiple concurrent tools', [
    event(1, 'user_message', { text: 'run both' }),
    event(2, 'tool_start', { callId: 'c1', tool: 'bash', input: { command: 'ls' } }),
    event(3, 'tool_start', { callId: 'c2', tool: 'read', input: { path: '/x.ts' } }),
    event(4, 'tool_end', { callId: 'c2', tool: 'read', output: 'contents' }),
    event(5, 'tool_end', { callId: 'c1', tool: 'bash', output: 'ok' }),
    event(6, 'assistant_message', { text: 'Both done' }),
  ]],
  ['user input resolution', [
    event(1, 'user_message', { text: 'need a choice' }),
    event(2, 'user_input_requested', { requestId: 'r1', title: 'Title', questions }),
    event(3, 'user_input_resolved', { requestId: 'r1', resolvedBy: 'user' }),
    event(4, 'assistant_message', { text: 'Got it' }),
  ]],
  ['interactive tool resolution', [
    event(1, 'tool_start', {
      callId: 'c1', tool: 'askquestion', input: { title: 'Title', questions },
    }),
    event(2, 'tool_end', { callId: 'c1', tool: 'askquestion', isError: false }),
    event(3, 'assistant_message', { text: 'Thanks' }),
  ]],
  ['provider request resolution', [
    event(1, 'user_message', { text: 'approve?' }),
    event(2, 'provider_request', { requestId: 'p1', provider: 'openai', method: 'chat' }),
    event(3, 'provider_request_resolved', { requestId: 'p1', decision: 'approve' }),
    event(4, 'assistant_message', { text: 'Approved' }),
  ]],
  ['orphan provider request resolution', [
    event(1, 'user_message', { text: 'hmm' }),
    event(2, 'provider_request_resolved', { requestId: 'p2', decision: 'deny' }),
    event(3, 'assistant_message', { text: 'ok' }),
  ]],
  ['before and after evidence folding', [
    event(1, 'evidence_captured', {
      beforeRef: { id: 'a'.repeat(32), mimeType: 'image/png' },
      route: '/app', viewport: { w: 1440, h: 900 }, workspaceHead: 'head-a',
    }),
    event(2, 'evidence_captured', {
      afterRef: { id: 'b'.repeat(32), mimeType: 'image/png' },
      route: '/app', viewport: { w: 1440, h: 900 }, workspaceHead: 'head-b',
    }),
  ]],
  ['steer message rendering', [
    event(1, 'user_message', { text: 'do X' }),
    event(2, 'assistant_delta', { delta: 'working' }),
    event(3, 'steer_message', { text: 'actually do Y' }),
    event(4, 'assistant_message', { text: 'Doing Y' }),
  ]],
  ['steer reservation reconciliation', [
    event(1, 'user_message', { text: 'do X' }),
    event(2, 'assistant_delta', { delta: 'working' }),
    event(3, 'steer_reserved', { text: 'actually do Y' }),
    event(4, 'steer_message', { text: 'actually do Y' }),
    event(5, 'assistant_message', { text: 'Doing Y' }),
  ]],
  ['mixed session ending in a streaming tail', [
    event(1, 'user_message', { text: 'turn 1' }),
    event(2, 'thinking_start', { thinkingId: 't1' }),
    event(3, 'thinking_delta', { delta: 'thinking...' }),
    event(4, 'thinking_message', { text: 'thinking...' }),
    event(5, 'tool_start', { callId: 'c1', tool: 'bash', input: { command: 'ls' } }),
    event(6, 'tool_end', { callId: 'c1', tool: 'bash', output: 'ok' }),
    event(7, 'assistant_message', { text: 'turn 1 response' }),
    event(8, 'user_message', { text: 'turn 2' }),
    event(9, 'tool_start', { callId: 'c2', tool: 'read', input: { path: '/y.ts' } }),
    event(10, 'tool_end', { callId: 'c2', tool: 'read', output: 'y contents' }),
    event(11, 'assistant_message', { text: 'turn 2 response' }),
    event(12, 'user_message', { text: 'turn 3' }),
    event(13, 'assistant_delta', { delta: 'partial resp' }),
    event(14, 'assistant_delta', { delta: 'onse still going' }),
  ]],
];

function expectEveryPrefixToMatchBatch(events: SessionEvent[]): void {
  const builder = createBuilder();
  expect(builder.update([])).toEqual([]);
  for (let length = 1; length <= events.length; length += 1) {
    const prefix = events.slice(0, length);
    expect(builder.update(prefix)).toEqual(buildTranscriptBlocks(prefix));
  }
}

describe('IncrementalTranscriptBuilder', () => {
  it.each(equivalenceCases)('matches the batch parser for %s', (_name, events) => {
    expectEveryPrefixToMatchBatch(events);
  });

  it('resets when a different session reuses identical seq values', () => {
    const builder = createBuilder();
    const sessionA = [
      event(1, 'user_message', { text: 'Phiên A 🧭' }),
      event(2, 'assistant_message', { text: 'Trả lời A' }),
    ];
    const sessionB = [
      event(1, 'user_message', { text: 'Phiên B 👋' }),
      event(2, 'assistant_message', { text: 'Trả lời B' }),
    ];

    expect(builder.update(sessionA)).toEqual(buildTranscriptBlocks(sessionA));
    expect(builder.update(sessionB)).toEqual(buildTranscriptBlocks(sessionB));
  });

  it('rebuilds after a backfill page is prepended to a checkpointed tail', () => {
    const builder = createBuilder();
    const tail = [
      event(5, 'user_message', { text: 'recent question' }),
      event(6, 'assistant_message', { text: 'recent answer' }),
    ];
    const full = [
      event(1, 'user_message', { text: 'older question' }),
      event(2, 'assistant_message', { text: 'older answer' }),
      event(3, 'user_message', { text: 'middle question' }),
      event(4, 'assistant_message', { text: 'middle answer' }),
      ...tail,
    ];

    builder.update(tail);
    expect(builder.update(full)).toEqual(buildTranscriptBlocks(full));
  });

  it('rebuilds when the event array shrinks', () => {
    const builder = createBuilder();
    const full = [
      event(1, 'user_message', { text: 'one' }),
      event(2, 'assistant_message', { text: 'reply one' }),
      event(3, 'user_message', { text: 'two' }),
      event(4, 'assistant_message', { text: 'reply two' }),
    ];

    builder.update(full);
    const shrunk = full.slice(0, 2);
    expect(builder.update(shrunk)).toEqual(buildTranscriptBlocks(shrunk));
  });

  it('rebuilds when an interior checkpoint prefix is reordered', () => {
    const builder = createBuilder();
    const original = [
      event(1, 'user_message', { text: 'one' }),
      event(2, 'assistant_message', { text: 'reply one' }),
      event(3, 'user_message', { text: 'two' }),
      event(4, 'assistant_message', { text: 'reply two' }),
    ];
    builder.update(original);

    const reordered = [original[2]!, original[1]!, original[0]!, original[3]!];
    expect(builder.update(reordered)).toEqual(buildTranscriptBlocks(reordered));
  });

  it('rebuilds when eviction makes a formerly duplicate user message visible', () => {
    const builder = createBuilder();
    const original = [
      event(1, 'user_message', { text: 'repeat me' }),
      event(2, 'assistant_message', { text: 'first reply' }),
      event(3, 'user_message', { text: 'repeat me' }),
      event(4, 'assistant_message', { text: 'second reply' }),
    ];
    builder.update(original);

    const rolled = [...original.slice(1), event(5, 'status', { status: 'RUNNING' })];
    const blocks = builder.update(rolled);
    expect(blocks).toEqual(buildTranscriptBlocks(rolled));
    expect(blocks).toContainEqual(
      expect.objectContaining({ kind: 'user', key: 'user-3', text: 'repeat me' }),
    );
  });

  it('exposes a public reset for explicit cache invalidation', () => {
    const builder = createBuilder();
    const events = [
      event(1, 'user_message', { text: 'before reset' }),
      event(2, 'assistant_message', { text: 'old answer' }),
    ];
    builder.update(events);

    events[0]!.payload = { text: 'after reset' };
    events[1]!.payload = { text: 'new answer' };
    builder.reset();

    expect(builder.update(events)).toEqual(buildTranscriptBlocks(events));
  });

  it('keeps the assistant block key stable from streaming through finalization', () => {
    const builder = createBuilder();
    const events = [
      event(1, 'user_message', { text: 'stream please' }),
      event(2, 'assistant_delta', { delta: 'hel' }),
    ];
    const firstKey = builder.update(events).find((block) => block.kind === 'assistant')?.key;

    events.push(event(3, 'assistant_delta', { delta: 'lo' }));
    expect(builder.update(events).find((block) => block.kind === 'assistant')?.key).toBe(firstKey);

    events.push(event(4, 'assistant_message', { text: 'hello' }));
    expect(builder.update(events).find((block) => block.kind === 'assistant')?.key).toBe(firstKey);
  });

  it('processes a 10,000-event rolling window in linear-scale work', () => {
    let processedEvents = 0;
    const builder = createBuilder(() => {
      processedEvents += 1;
    });
    const events = Array.from({ length: 10_000 }, (_, index) => {
      const seq = index + 1;
      return seq % 2 === 1
        ? event(seq, 'user_message', { text: `question ${seq}` })
        : event(seq, 'assistant_message', { text: `answer ${seq}` });
    });

    for (let end = 1; end <= events.length; end += 1) {
      const window = events.slice(Math.max(0, end - 1_000), end);
      const blocks = builder.update(window);
      if (end <= 1_005 || end % 997 === 0 || end === events.length) {
        expect(blocks).toEqual(buildTranscriptBlocks(window));
      }
    }

    expect(processedEvents).toBeGreaterThanOrEqual(events.length);
    expect(processedEvents).toBeLessThanOrEqual(events.length * 2);
  });
});
