import { piEntriesToSessionEvents } from '../../../src/pi-local/pi-transcript-hydrate';

describe('piEntriesToSessionEvents', () => {
  it('maps pi SDK parsed entries to Nuncio transcript events and skips thinking', () => {
    const events = piEntriesToSessionEvents([
      {
        type: 'message',
        message: { role: 'user', content: [{ type: 'text', text: 'Continue from phone' }] },
      },
      {
        type: 'message',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'private chain of thought' },
            { type: 'toolCall', id: 'call-1', name: 'read', arguments: { path: 'README.md' } },
            { type: 'text', text: 'I checked it.' },
          ],
        },
      },
      {
        type: 'message',
        message: { role: 'toolResult', content: [{ type: 'text', text: 'file contents' }] },
      },
    ] as never);

    expect(events).toEqual([
      { type: 'user_message', payload: { text: 'Continue from phone' } },
      { type: 'tool_start', payload: { callId: 'call-1', tool: 'read', input: { path: 'README.md' } } },
      { type: 'assistant_message', payload: { text: 'I checked it.' } },
      { type: 'tool_end', payload: { callId: 'call-1', tool: 'read', isError: false, output: 'file contents' } },
    ]);
  });
});
