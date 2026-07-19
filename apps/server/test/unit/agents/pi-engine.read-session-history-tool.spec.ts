import { describe, expect, it } from 'bun:test';
import {
  buildReadSessionHistoryTool,
  READ_SESSION_HISTORY_TOOL_NAME,
  type ReadSessionHistoryDeps,
} from '../../../src/agents/pi-engine/read-session-history-tool';

/**
 * The transcript pointer made real (phase 06): compaction summaries reference
 * read_session_history so the model can re-read turns that were compacted
 * away — Nuncio's durable event log is the transcript_location analog, with a
 * seekable seq cursor instead of a file path.
 */

interface ToolResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

interface PiToolLike {
  name: string;
  description: string;
  execute(toolCallId: string, params: unknown): Promise<ToolResult>;
}

function makeEvents(count: number, type = 'user_message') {
  return Array.from({ length: count }, (_, index) => ({
    seq: index + 1,
    type,
    payload: { text: `message number ${index + 1}` },
    createdAt: 1000 + index,
  }));
}

function makeDeps(events: ReturnType<typeof makeEvents>): ReadSessionHistoryDeps & {
  calls: Array<{ sinceSeq: number; limit: number }>;
} {
  const calls: Array<{ sinceSeq: number; limit: number }> = [];
  return {
    calls,
    sessionId: 'session-1',
    listEvents: (sinceSeq, limit) => {
      calls.push({ sinceSeq, limit });
      return events.filter((event) => event.seq > sinceSeq).slice(0, limit);
    },
  };
}

function tool(deps: ReadSessionHistoryDeps): PiToolLike {
  return buildReadSessionHistoryTool(deps) as PiToolLike;
}

describe('buildReadSessionHistoryTool', () => {
  it('renders a bounded timeline from the durable log', async () => {
    const result = await tool(makeDeps(makeEvents(3))).execute('c1', {});
    expect(result.isError).toBeUndefined();
    expect(result.content[0]!.text).toContain('message number 1');
    expect(result.content[0]!.text).toContain('message number 3');
  });

  it('reads from sinceSeq and honors untilSeq', async () => {
    const deps = makeDeps(makeEvents(10));
    const result = await tool(deps).execute('c1', { sinceSeq: 4, untilSeq: 6 });
    const text = result.content[0]!.text;
    expect(deps.calls[0]!.sinceSeq).toBe(4);
    expect(text).toContain('message number 5');
    expect(text).toContain('message number 6');
    expect(text).not.toContain('message number 7');
  });

  it('filters by event types when given', async () => {
    const events = [
      { seq: 1, type: 'user_message', payload: { text: 'keep the user ask' }, createdAt: 1 },
      { seq: 2, type: 'assistant_message', payload: { text: 'drop the assistant reply' }, createdAt: 2 },
    ];
    const deps = { sessionId: 's', listEvents: () => events };
    const result = await tool(deps).execute('c1', { types: ['user_message'] });
    expect(result.content[0]!.text).toContain('keep the user ask');
    expect(result.content[0]!.text).not.toContain('drop the assistant reply');
  });

  it('caps the requested limit and the output size', async () => {
    const deps = makeDeps(makeEvents(2000));
    const result = await tool(deps).execute('c1', { limit: 99_999 });
    expect(deps.calls[0]!.limit).toBeLessThanOrEqual(500);
    expect(result.content[0]!.text.length).toBeLessThanOrEqual(30_000);
  });

  it('says so when the range holds nothing renderable', async () => {
    const result = await tool(makeDeps([])).execute('c1', { sinceSeq: 999 });
    expect(result.isError).toBeUndefined();
    expect(result.content[0]!.text).toContain('No events');
  });

  it('rejects malformed input without calling the log', async () => {
    const deps = makeDeps(makeEvents(3));
    const bad = await tool(deps).execute('c1', { sinceSeq: 'ten' });
    expect(bad.isError).toBe(true);
    expect(deps.calls).toHaveLength(0);
  });

  it('exposes the canonical tool name and wraps through defineTool', () => {
    const seen: unknown[] = [];
    const built = buildReadSessionHistoryTool(makeDeps([]), (definition) => {
      seen.push(definition);
      return { wrapped: definition };
    });
    expect((seen[0] as { name: string }).name).toBe(READ_SESSION_HISTORY_TOOL_NAME);
    expect(built).toEqual({ wrapped: seen[0] });
  });
});
