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
});
