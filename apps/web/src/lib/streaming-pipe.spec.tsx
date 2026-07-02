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
    expect(blocks.filter((block) => block.kind === 'assistant')).toEqual([
      { kind: 'assistant', text: 'The project looks healthy.' },
    ]);
  });
});
