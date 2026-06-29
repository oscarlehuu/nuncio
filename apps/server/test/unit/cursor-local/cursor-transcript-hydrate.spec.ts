import { turnsToSessionEvents } from '../../../src/cursor-local/cursor-transcript-hydrate';
import type { ParsedTranscriptTurn } from '../../../src/cursor-local/cursor-transcript.parser';

describe('turnsToSessionEvents', () => {
  it('emits tool_start with input from parsed tools', () => {
    const turns: ParsedTranscriptTurn[] = [
      {
        role: 'assistant',
        text: 'Checking',
        toolNames: ['Read'],
        tools: [{ name: 'Read', input: { path: '/foo.ts' } }],
      },
    ];
    const events = turnsToSessionEvents(turns);
    const toolStart = events.find((e) => e.type === 'tool_start');
    expect(toolStart?.payload).toEqual({ tool: 'Read', input: { path: '/foo.ts' } });
    expect(events.some((e) => e.type === 'tool_end')).toBe(true);
    expect(events.some((e) => e.type === 'assistant_message')).toBe(true);
  });
});
