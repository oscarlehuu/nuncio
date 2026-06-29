import { describe, expect, it } from 'vitest';
import type { SessionEvent } from './api';
import { buildTranscriptBlocks, workingIndicatorLabel } from './transcript-build-blocks';

function ev(seq: number, type: string, payload: Record<string, unknown>): SessionEvent {
  return { seq, type, payload, createdAt: seq };
}

describe('buildTranscriptBlocks', () => {
  it('pairs legacy tool_start and tool_end into one done block', () => {
    const blocks = buildTranscriptBlocks([
      ev(1, 'tool_start', { tool: 'Read' }),
      ev(2, 'tool_end', { tool: 'Read', isError: false }),
    ]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ kind: 'tool', tool: 'Read', status: 'done' });
  });

  it('pairs tool events by callId', () => {
    const blocks = buildTranscriptBlocks([
      ev(1, 'tool_start', { callId: 'c1', tool: 'bash', input: { cmd: 'ls' } }),
      ev(2, 'tool_end', { callId: 'c1', tool: 'bash', output: 'ok' }),
    ]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      kind: 'tool',
      callId: 'c1',
      status: 'done',
      input: { cmd: 'ls' },
      output: 'ok',
    });
  });

  it('attaches a Cursor-style summary to each tool block', () => {
    const blocks = buildTranscriptBlocks([
      ev(1, 'tool_start', { callId: 'c1', tool: 'read', input: { path: '/Users/me/x.ts' } }),
      ev(2, 'tool_end', { callId: 'c1', tool: 'read' }),
    ]);
    const tool = blocks[0];
    expect(tool.kind).toBe('tool');
    if (tool.kind === 'tool') {
      expect(tool.summary).toEqual({ verb: 'Read', subject: 'x.ts', context: undefined });
    }
  });

  it('summarizes bash commands', () => {
    const blocks = buildTranscriptBlocks([
      ev(1, 'tool_start', { callId: 'c1', tool: 'bash', input: { cmd: 'pnpm test' } }),
    ]);
    const tool = blocks[0];
    expect(tool.kind).toBe('tool');
    if (tool.kind === 'tool') {
      expect(tool.summary.verb).toBe('Ran');
      expect(tool.summary.subject).toBe('pnpm test');
    }
  });

  it('drops assistant messages that are only [REDACTED]', () => {
    const blocks = buildTranscriptBlocks([
      ev(1, 'assistant_message', { text: '[REDACTED]' }),
      ev(2, 'assistant_message', { text: 'Real response' }),
    ]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ kind: 'assistant', text: 'Real response' });
  });

  it('strips inline [REDACTED] from assistant text but keeps the rest', () => {
    const blocks = buildTranscriptBlocks([
      ev(1, 'assistant_message', { text: 'Checking docs.\n\n[REDACTED]' }),
    ]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ kind: 'assistant', text: 'Checking docs.' });
  });

  it('strips [REDACTED] appearing mid-text', () => {
    const blocks = buildTranscriptBlocks([
      ev(1, 'assistant_message', { text: 'Before [REDACTED] after' }),
    ]);
    expect(blocks).toHaveLength(1);
    if (blocks[0].kind === 'assistant') {
      expect(blocks[0].text).toBe('Before  after');
    }
  });

  it('detects Cursor context messages and emits a cursor-context block', () => {
    const blocks = buildTranscriptBlocks([
      ev(1, 'user_message', {
        text: 'Investigate CI failures\n<pr_shared_context>\nheadSha: abc\n</pr_shared_context>',
      }),
    ]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].kind).toBe('cursor-context');
    if (blocks[0].kind === 'cursor-context') {
      expect(blocks[0].summary).toMatch(/investigation/i);
      expect(blocks[0].sections).toHaveLength(1);
      expect(blocks[0].sections[0].tag).toBe('pr_shared_context');
    }
  });

  it('emits a plain user block for non-Cursor user messages', () => {
    const blocks = buildTranscriptBlocks([
      ev(1, 'user_message', { text: 'Hello agent' }),
    ]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].kind).toBe('user');
  });

  it('interleaves user, tool, and assistant content in order', () => {
    const blocks = buildTranscriptBlocks([
      ev(1, 'user_message', { text: 'hi' }),
      ev(2, 'tool_start', { callId: 'c1', tool: 'Read' }),
      ev(3, 'tool_end', { callId: 'c1', tool: 'Read' }),
      ev(4, 'assistant_delta', { delta: 'Hello' }),
      ev(5, 'assistant_message', { text: 'Hello' }),
    ]);
    expect(blocks.map((b) => b.kind)).toEqual(['user', 'tool', 'assistant']);
  });

  it('keeps thinking text out of assistant blocks', () => {
    const blocks = buildTranscriptBlocks([
      ev(1, 'thinking_start', { thinkingId: 't1' }),
      ev(2, 'thinking_delta', { delta: 'hmm' }),
      ev(3, 'thinking_message', { text: 'hmm' }),
      ev(4, 'assistant_message', { text: 'Answer' }),
    ]);
    expect(blocks.some((b) => b.kind === 'thinking' && b.text === 'hmm')).toBe(true);
    expect(blocks.find((b) => b.kind === 'assistant')?.text).toBe('Answer');
  });

  it('marks streaming assistant buffer at end', () => {
    const blocks = buildTranscriptBlocks([ev(1, 'assistant_delta', { delta: 'partial' })]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ kind: 'assistant', text: 'partial', streaming: true });
  });

  it('leaves open tool as running', () => {
    const blocks = buildTranscriptBlocks([ev(1, 'tool_start', { callId: 'c1', tool: 'grep' })]);
    expect(blocks[0]).toMatchObject({ kind: 'tool', status: 'running' });
  });

  it('splits appended thinking into a separate thinking block (Cursor JSONL concatenates response + thinking)', () => {
    const text = 'Đúng vậy. ACP và SDK về cơ bản là cùng một mô hình.\n\nNói tóm lại: ACP không giải quyết được vấn đề handoff.\n\nThe user is asking a clarifying question about ACP vs SDK. Let me think about this carefully.';
    const blocks = buildTranscriptBlocks([ev(1, 'assistant_message', { text })]);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].kind).toBe('assistant');
    expect((blocks[0] as { text: string }).text).toBe(
      'Đúng vậy. ACP và SDK về cơ bản là cùng một mô hình.\n\nNói tóm lại: ACP không giải quyết được vấn đề handoff.',
    );
    expect(blocks[1].kind).toBe('thinking');
    expect((blocks[1] as { text: string }).text).toContain('The user is asking a clarifying question');
  });

  it('does not split thinking-like phrases that are part of the actual response', () => {
    const text = 'The user wants to implement ACP. This is a significant architectural decision.';
    const blocks = buildTranscriptBlocks([ev(1, 'assistant_message', { text })]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].kind).toBe('assistant');
    expect((blocks[0] as { text: string }).text).toBe(text);
  });

  it('splits thinking starting with "Let me think" patterns', () => {
    const text = 'Here is the response.\n\nLet me think about this carefully and provide a good answer.';
    const blocks = buildTranscriptBlocks([ev(1, 'assistant_message', { text })]);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].kind).toBe('assistant');
    expect((blocks[0] as { text: string }).text).toBe('Here is the response.');
    expect(blocks[1].kind).toBe('thinking');
  });
});

describe('workingIndicatorLabel', () => {
  it('reports writing when assistant is streaming', () => {
    const blocks = buildTranscriptBlocks([ev(1, 'assistant_delta', { delta: 'x' })]);
    expect(workingIndicatorLabel(blocks, true)).toBe('Nuncio is writing…');
  });

  it('reports tool name when a tool is running', () => {
    const blocks = buildTranscriptBlocks([ev(1, 'tool_start', { callId: 'c1', tool: 'Read' })]);
    expect(workingIndicatorLabel(blocks, true)).toBe('Nuncio is using Read…');
  });
});
