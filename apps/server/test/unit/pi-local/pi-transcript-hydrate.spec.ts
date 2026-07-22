import { piEntriesToSessionEvents } from '../../../src/pi-local/pi-transcript-hydrate';

describe('piEntriesToSessionEvents', () => {
  it('decodes a legacy Nuncio runtime suffix back to the canonical user input', () => {
    const browserInstructions =
      'When the user asks for browser, web, UI, site, screenshot, or visual verification work, use the Nuncio browser tools first. Omit target to use the configured default from Settings > MCP & Tools; target=auto prefers the Nuncio in-app browser, then falls back to the Nuncio-owned external CDP browser.';

    const events = piEntriesToSessionEvents([
      {
        type: 'message',
        message: {
          role: 'user',
          content: [{ type: 'text', text: `Continue from phone\n\n${browserInstructions}` }],
        },
      },
    ] as never);

    expect(events).toEqual([
      { type: 'user_message', payload: { text: 'Continue from phone' } },
    ]);
  });

  it('preserves text after the legacy browser paragraph instead of truncating user content', () => {
    const browserInstructions =
      'When the user asks for browser, web, UI, site, screenshot, or visual verification work, use the Nuncio browser tools first. Omit target to use the configured default from Settings > MCP & Tools; target=auto prefers the Nuncio in-app browser, then falls back to the Nuncio-owned external CDP browser.';
    const text = `Continue from phone\n\n${browserInstructions}\n\nKeep this user paragraph.`;

    const events = piEntriesToSessionEvents([
      {
        type: 'message',
        message: { role: 'user', content: [{ type: 'text', text }] },
      },
    ] as never);

    expect(events).toEqual([{ type: 'user_message', payload: { text } }]);
  });

  it('does not invent success when a standalone tool result omits error state', () => {
    const events = piEntriesToSessionEvents([
      {
        type: 'message',
        message: {
          role: 'toolResult',
          content: [{ type: 'text', text: 'legacy output' }],
        },
      },
    ] as never);

    expect(events).toEqual([
      {
        type: 'tool_end',
        payload: { tool: 'toolResult', output: 'legacy output' },
      },
    ]);
  });

  it('preserves authoritative identity and failure state on a standalone tool result', () => {
    const events = piEntriesToSessionEvents([
      {
        type: 'message',
        message: {
          role: 'toolResult',
          toolCallId: 'call-failed',
          toolName: 'bäsh工具',
          isError: true,
          content: [{ type: 'text', text: 'command failed' }],
        },
      },
    ] as never);

    expect(events).toEqual([
      {
        type: 'tool_end',
        payload: {
          callId: 'call-failed',
          tool: 'bäsh工具',
          isError: true,
          output: 'command failed',
        },
      },
    ]);
  });

  it('removes authoritative out-of-order results from pending fallback ownership', () => {
    const events = piEntriesToSessionEvents([
      {
        type: 'message',
        message: {
          role: 'assistant',
          content: [
            { type: 'toolCall', id: 'call-a', name: 'alpha', arguments: {} },
            { type: 'toolCall', id: 'call-b', name: 'beta', arguments: {} },
          ],
        },
      },
      {
        type: 'message',
        message: {
          role: 'toolResult',
          toolCallId: 'call-b',
          content: [{ type: 'text', text: 'beta output' }],
        },
      },
      {
        type: 'message',
        message: {
          role: 'toolResult',
          toolCallId: 'call-a',
          content: [{ type: 'text', text: 'alpha output' }],
        },
      },
      {
        type: 'message',
        message: {
          role: 'toolResult',
          content: [{ type: 'text', text: 'legacy output' }],
        },
      },
    ] as never);

    expect(events.filter((event) => event.type === 'tool_end')).toEqual([
      {
        type: 'tool_end',
        payload: { callId: 'call-b', tool: 'beta', output: 'beta output' },
      },
      {
        type: 'tool_end',
        payload: { callId: 'call-a', tool: 'alpha', output: 'alpha output' },
      },
      {
        type: 'tool_end',
        payload: { tool: 'toolResult', output: 'legacy output' },
      },
    ]);
  });

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
        message: {
          role: 'toolResult',
          toolCallId: 'call-1',
          toolName: 'read',
          isError: false,
          content: [{ type: 'text', text: 'file contents' }],
        },
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
