import type { ParsedTranscriptTurn } from '../cursor-local/cursor-transcript.parser';
import { truncatePayload } from '../sessions/domain/events.types';

export function turnsToSessionEvents(
  turns: ParsedTranscriptTurn[],
): Array<{ type: string; payload: unknown }> {
  const events: Array<{ type: string; payload: unknown }> = [];
  for (const turn of turns) {
    if (turn.role === 'user') {
      events.push({ type: 'user_message', payload: { text: turn.text } });
      continue;
    }
    for (const tool of turn.tools) {
      const input =
        tool.input !== undefined ? truncatePayload(tool.input).value : undefined;
      events.push({
        type: 'tool_start',
        payload: {
          tool: tool.name,
          ...(input !== undefined ? { input } : {}),
        },
      });
      events.push({ type: 'tool_end', payload: { tool: tool.name, isError: false } });
    }
    if (turn.text) {
      events.push({ type: 'assistant_message', payload: { text: turn.text } });
    }
  }
  return events;
}
