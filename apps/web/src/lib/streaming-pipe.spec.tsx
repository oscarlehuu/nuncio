import { describe, expect, it } from 'vitest';
import type { SessionEvent } from './api';
import { buildTranscriptBlocks } from './transcript-build-blocks';

function ev(seq: number, type: string, payload: Record<string, unknown> = {}): SessionEvent {
  return { seq, type, payload, createdAt: seq };
}

describe('streaming transcript pipe', () => {
  it('builds an ordered live burst with inline thinking, resolved tools, and one assembled assistant answer', () => {
    const blocks = buildTranscriptBlocks([
      ev(1, 'user_message', { text: 'Inspect the project' }),
      ev(2, 'thinking_start', { thinkingId: 'think-1' }),
      ev(3, 'thinking_delta', { thinkingId: 'think-1', delta: 'Need to inspect ' }),
      ev(4, 'thinking_delta', { thinkingId: 'think-1', delta: 'the files.' }),
      ev(5, 'thinking_message', { thinkingId: 'think-1', text: 'Need to inspect the files.' }),
      ev(6, 'tool_start', { callId: 'tool-1', tool: 'read', input: { path: 'src/index.ts' } }),
      ev(7, 'tool_end', { callId: 'tool-1', tool: 'read', isError: false, output: 'export {}' }),
      ev(8, 'assistant_delta', { delta: 'The project ' }),
      ev(9, 'assistant_delta', { delta: 'looks healthy.' }),
      ev(10, 'assistant_message', { text: 'The project looks healthy.' }),
      ev(11, 'transcript_refreshed', { added: 0 }),
    ]);

    expect(blocks.map((block) => block.kind)).toEqual(['user', 'thinking', 'tool', 'assistant']);
    expect(blocks[1]).toMatchObject({
      kind: 'thinking',
      thinkingId: 'think-1',
      text: 'Need to inspect the files.',
    });
    expect(blocks[2]).toMatchObject({
      kind: 'tool',
      callId: 'tool-1',
      tool: 'read',
      status: 'done',
      output: 'export {}',
    });
    expect(blocks.filter((block) => block.kind === 'tool' && block.status === 'running')).toHaveLength(0);
    expect(blocks.filter((block) => block.kind === 'assistant')).toMatchObject([
      { kind: 'assistant', text: 'The project looks healthy.' },
    ]);
  });

  it('renders exactly the authoritative final text when deltas would glue or drop the tail', () => {
    // Guards the glued/missing-tail failure mode: a delta stream can be lossy
    // or mis-chunked (here the naive concatenation "Finalanswer.EXTRA" is wrong
    // and even loses a space), but the authoritative assistant_message must
    // override the accumulated buffer so the rendered answer is exactly correct.
    const blocks = buildTranscriptBlocks([
      ev(1, 'user_message', { text: 'Give the final answer' }),
      ev(2, 'assistant_delta', { delta: 'Final' }),
      ev(3, 'assistant_delta', { delta: 'answer.' }), // missing leading space (glue)
      ev(4, 'assistant_delta', { delta: 'EXTRA' }), // stray tail chunk
      ev(5, 'assistant_message', { text: 'Final answer. The tail is complete.' }),
    ]);

    const assistant = blocks.filter((block) => block.kind === 'assistant');
    expect(assistant).toHaveLength(1);
    expect(assistant[0]).toMatchObject({
      kind: 'assistant',
      text: 'Final answer. The tail is complete.',
    });
    // No streaming flag survives once the authoritative message has landed.
    expect(assistant[0]).not.toHaveProperty('streaming', true);
  });

  it('keeps the streaming tail intact when the run ends only in deltas (no authoritative message yet)', () => {
    // Mirror of the above: while still streaming, the full accumulated delta
    // text (every chunk, in order) must be present — the tail is never dropped.
    const blocks = buildTranscriptBlocks([
      ev(1, 'user_message', { text: 'stream it' }),
      ev(2, 'assistant_delta', { delta: 'The quick ' }),
      ev(3, 'assistant_delta', { delta: 'brown fox ' }),
      ev(4, 'assistant_delta', { delta: 'jumps over the lazy tail' }),
    ]);
    const assistant = blocks.filter((block) => block.kind === 'assistant');
    expect(assistant).toHaveLength(1);
    expect(assistant[0]).toMatchObject({
      kind: 'assistant',
      text: 'The quick brown fox jumps over the lazy tail',
      streaming: true,
    });
  });
});
