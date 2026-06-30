import { turnsToSessionEvents } from '../../../src/cursor-local/cursor-transcript-hydrate';
import type { ParsedTranscriptTurn } from '../../../src/cursor-local/cursor-transcript.parser';

const sampleQuestion = {
  id: 'q1',
  prompt: 'Which lane?',
  options: [{ id: 'a', label: 'Frontend', description: 'UI work' }],
};

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

  it('emits user_input_requested + user_input_resolved for AskQuestion (array form)', () => {
    const turns: ParsedTranscriptTurn[] = [
      {
        role: 'assistant',
        text: '',
        toolNames: ['AskQuestion'],
        tools: [
          {
            name: 'AskQuestion',
            input: { title: 'Pick scope', questions: [sampleQuestion] },
          },
        ],
      },
    ];
    const events = turnsToSessionEvents(turns);
    const requested = events.find((e) => e.type === 'user_input_requested');
    const resolved = events.find((e) => e.type === 'user_input_resolved');

    expect(requested?.payload).toMatchObject({
      questions: [sampleQuestion],
      title: 'Pick scope',
    });
    expect(typeof (requested?.payload as { requestId?: string }).requestId).toBe('string');
    expect((requested?.payload as { requestId?: string }).requestId).toBeTruthy();

    expect(resolved?.payload).toEqual({
      requestId: (requested?.payload as { requestId: string }).requestId,
      resolvedBy: 'user',
    });
    expect(events.some((e) => e.type === 'tool_start')).toBe(false);
    expect(events.some((e) => e.type === 'tool_end')).toBe(false);
  });

  it('emits user_input events for string-form questions', () => {
    const turns: ParsedTranscriptTurn[] = [
      {
        role: 'assistant',
        text: '',
        toolNames: ['AskQuestion'],
        tools: [
          {
            name: 'AskQuestion',
            input: { questions: JSON.stringify([sampleQuestion]) },
          },
        ],
      },
    ];
    const events = turnsToSessionEvents(turns);
    expect(events.some((e) => e.type === 'user_input_requested')).toBe(true);
    expect(events.some((e) => e.type === 'user_input_resolved')).toBe(true);
  });

  it('falls back to tool_start/end when AskQuestion questions are malformed', () => {
    const turns: ParsedTranscriptTurn[] = [
      {
        role: 'assistant',
        text: '',
        toolNames: ['AskQuestion'],
        tools: [{ name: 'AskQuestion', input: { questions: '{bad json' } }],
      },
    ];
    const events = turnsToSessionEvents(turns);
    expect(events.some((e) => e.type === 'tool_start')).toBe(true);
    expect(events.some((e) => e.type === 'user_input_requested')).toBe(false);
  });

  it('falls back to tool_start/end when AskQuestion questions are missing', () => {
    const turns: ParsedTranscriptTurn[] = [
      {
        role: 'assistant',
        text: '',
        toolNames: ['AskQuestion'],
        tools: [{ name: 'AskQuestion', input: { title: 'No questions' } }],
      },
    ];
    const events = turnsToSessionEvents(turns);
    expect(events.some((e) => e.type === 'tool_start')).toBe(true);
    expect(events.some((e) => e.type === 'user_input_requested')).toBe(false);
  });

  it('keeps user_message after AskQuestion as the answer bubble', () => {
    const turns: ParsedTranscriptTurn[] = [
      {
        role: 'assistant',
        text: '',
        toolNames: ['AskQuestion'],
        tools: [{ name: 'AskQuestion', input: { questions: [sampleQuestion] } }],
      },
      {
        role: 'user',
        text: 'Frontend please',
        toolNames: [],
        tools: [],
      },
    ];
    const events = turnsToSessionEvents(turns);
    const userMsg = events.find((e) => e.type === 'user_message');
    expect(userMsg?.payload).toEqual({ text: 'Frontend please' });
  });
});
