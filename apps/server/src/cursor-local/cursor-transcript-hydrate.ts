import { createHash } from 'node:crypto';
import type { ParsedTranscriptTool, ParsedTranscriptTurn } from '../cursor-local/cursor-transcript.parser';
import { isInteractiveTool } from '../agents/tool-interaction.registry';
import { truncatePayload } from '../sessions/domain/events.types';
import { buildUserInputRequestedPayload } from '../sessions/domain/interactive-tool-events';

function stableHistoricalRequestId(turnIndex: number, tool: ParsedTranscriptTool): string {
  const hash = createHash('sha256')
    .update(`${turnIndex}:${tool.name}:${JSON.stringify(tool.input ?? null)}`)
    .digest('hex')
    .slice(0, 32);
  return `hist-${hash}`;
}

export function turnsToSessionEvents(
  turns: ParsedTranscriptTurn[],
): Array<{ type: string; payload: unknown }> {
  const events: Array<{ type: string; payload: unknown }> = [];
  for (let turnIndex = 0; turnIndex < turns.length; turnIndex++) {
    const turn = turns[turnIndex];
    if (turn.role === 'user') {
      events.push({ type: 'user_message', payload: { text: turn.text } });
      continue;
    }
    for (const tool of turn.tools) {
      if (isInteractiveTool(tool.name)) {
        const requestId = stableHistoricalRequestId(turnIndex, tool);
        const payload = buildUserInputRequestedPayload(tool.name, tool.input, requestId);
        if (payload) {
          events.push({ type: 'user_input_requested', payload });
          events.push({
            type: 'user_input_resolved',
            payload: { requestId, resolvedBy: 'user' },
          });
          continue;
        }
      }

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
