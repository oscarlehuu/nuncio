import type { ParsedTranscriptTurn } from '../cursor-local/cursor-transcript.parser';

export function turnsToSessionEvents(
  turns: ParsedTranscriptTurn[],
): Array<{ type: string; payload: unknown }> {
  const events: Array<{ type: string; payload: unknown }> = [];
  for (const turn of turns) {
    if (turn.role === 'user') {
      events.push({ type: 'user_message', payload: { text: turn.text } });
      continue;
    }
    for (const tool of turn.toolNames) {
      events.push({ type: 'tool_start', payload: { tool } });
      events.push({ type: 'tool_end', payload: { tool, isError: false } });
    }
    if (turn.text) {
      events.push({ type: 'assistant_message', payload: { text: turn.text } });
    }
  }
  return events;
}
