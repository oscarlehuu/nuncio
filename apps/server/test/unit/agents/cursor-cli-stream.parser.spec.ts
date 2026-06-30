import { DEFAULT_PAYLOAD_MAX_BYTES } from '../../../src/sessions/domain/events.types';
import { parseCursorCliStreamLine } from '../../../src/agents/providers/cursor-cli.helpers';

describe('parseCursorCliStreamLine', () => {
  it('maps token assistant lines to assistant_delta', () => {
    const line = JSON.stringify({
      type: 'assistant',
      timestamp_ms: 123,
      message: { content: [{ type: 'text', text: 'P' }] },
    });
    expect(parseCursorCliStreamLine(line)).toEqual({ kind: 'assistant_delta', delta: 'P' });
  });

  it('skips assistant flush without timestamp_ms', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'PONG' }] },
    });
    expect(parseCursorCliStreamLine(line)).toEqual({ kind: 'skip' });
  });

  it('maps success result to assistant_message', () => {
    const line = JSON.stringify({ type: 'result', subtype: 'success', result: 'PONG' });
    expect(parseCursorCliStreamLine(line)).toEqual({ kind: 'assistant_message', text: 'PONG' });
  });

  it('maps error result to error', () => {
    const line = JSON.stringify({ type: 'result', subtype: 'error', error: 'boom' });
    expect(parseCursorCliStreamLine(line)).toEqual({ kind: 'error', message: 'boom' });
  });

  it('maps tool_call started to tool_start with input', () => {
    const line = JSON.stringify({
      type: 'tool_call',
      subtype: 'started',
      call_id: 'tool_abc',
      tool_call: {
        readToolCall: { args: { path: '/README.md', limit: 1 } },
      },
    });
    expect(parseCursorCliStreamLine(line)).toEqual({
      kind: 'tool_start',
      callId: 'tool_abc',
      tool: 'read',
      input: { path: '/README.md', limit: 1 },
    });
  });

  it('maps tool_call completed to tool_end with output', () => {
    const line = JSON.stringify({
      type: 'tool_call',
      subtype: 'completed',
      call_id: 'tool_abc',
      tool_call: {
        readToolCall: {
          args: { path: '/README.md', limit: 1 },
          result: { success: { content: '# Nuncio' } },
        },
      },
    });
    expect(parseCursorCliStreamLine(line)).toEqual({
      kind: 'tool_end',
      callId: 'tool_abc',
      tool: 'read',
      isError: false,
      output: { success: { content: '# Nuncio' } },
    });
  });

  it('truncates oversized tool output', () => {
    const big = 'x'.repeat(DEFAULT_PAYLOAD_MAX_BYTES + 50);
    const line = JSON.stringify({
      type: 'tool_call',
      subtype: 'completed',
      call_id: 'tool_big',
      tool_call: { bashToolCall: { result: big } },
    });
    const parsed = parseCursorCliStreamLine(line);
    expect(parsed.kind).toBe('tool_end');
    if (parsed.kind !== 'tool_end') return;
    const output = parsed.output as { truncated: boolean; preview: string };
    expect(output.truncated).toBe(true);
    expect(output.preview.length).toBeLessThanOrEqual(DEFAULT_PAYLOAD_MAX_BYTES);
  });
});
