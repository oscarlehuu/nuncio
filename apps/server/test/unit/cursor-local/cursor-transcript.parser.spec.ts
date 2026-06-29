import { parseTranscriptLine, stripPromptWrappers, titleFromTurn } from '../../../src/cursor-local/cursor-transcript.parser';

describe('cursor-transcript.parser', () => {
  it('parses a user turn and strips user_query wrapper', () => {
    const line = JSON.stringify({
      role: 'user',
      message: {
        content: [{ type: 'text', text: '<user_query>\nFix the bug\n</user_query>' }],
      },
    });
    const turn = parseTranscriptLine(line);
    expect(turn?.role).toBe('user');
    expect(turn?.text).toBe('Fix the bug');
  });

  it('parses assistant text and tool names', () => {
    const line = JSON.stringify({
      role: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'Checking files' },
          { type: 'tool_use', name: 'Read' },
        ],
      },
    });
    const turn = parseTranscriptLine(line);
    expect(turn?.role).toBe('assistant');
    expect(turn?.text).toBe('Checking files');
    expect(turn?.toolNames).toEqual(['Read']);
    expect(turn?.tools).toEqual([{ name: 'Read' }]);
  });

  it('preserves tool_use input', () => {
    const line = JSON.stringify({
      role: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            name: 'Read',
            input: { path: '/foo.ts', limit: 10 },
          },
        ],
      },
    });
    const turn = parseTranscriptLine(line);
    expect(turn?.tools).toEqual([{ name: 'Read', input: { path: '/foo.ts', limit: 10 } }]);
  });

  it('returns null for malformed JSON', () => {
    expect(parseTranscriptLine('not-json')).toBeNull();
  });

  it('titleFromTurn truncates long titles', () => {
    const title = titleFromTurn({
      role: 'user',
      text: 'a'.repeat(100),
      toolNames: [],
      tools: [],
    });
    expect(title.length).toBe(80);
    expect(title.endsWith('...')).toBe(true);
  });

  it('stripPromptWrappers leaves plain text unchanged', () => {
    expect(stripPromptWrappers('hello')).toBe('hello');
  });
});
