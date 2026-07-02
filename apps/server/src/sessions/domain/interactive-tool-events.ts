import { isInteractiveTool } from '../../agents/tool-interaction.registry';
import { truncatePayload } from './events.types';
import { normalizeUserInput, type UserInputQuestion } from './user-input.types';

export interface UserInputRequestedEventPayload {
  requestId: string;
  questions: UserInputQuestion[];
  title?: string;
}

export function buildUserInputRequestedPayload(
  tool: string,
  input: unknown,
  requestId: string,
): UserInputRequestedEventPayload | undefined {
  if (!isInteractiveTool(tool)) return undefined;
  const normalized = normalizeUserInput(tool, input);
  if (!normalized) return undefined;

  const questions = truncatePayload(normalized.questions).value as UserInputQuestion[];
  return {
    requestId,
    questions,
    ...(normalized.title ? { title: normalized.title } : {}),
  };
}

/**
 * Scan a session's event log for a user_input_requested event that has not
 * been answered yet. Returns undefined for unknown or already-resolved ids.
 */
export function findOpenUserInputRequest(
  events: Iterable<{ type: string; payload: unknown }>,
  requestId: string,
): UserInputRequestedEventPayload | undefined {
  let requested: UserInputRequestedEventPayload | undefined;
  let resolved = false;

  for (const event of events) {
    if (event.type === 'user_input_requested') {
      const payload = event.payload as UserInputRequestedEventPayload;
      if (payload.requestId === requestId) requested = payload;
    }
    if (event.type === 'user_input_resolved') {
      const payload = event.payload as { requestId?: string };
      if (payload.requestId === requestId) resolved = true;
    }
  }

  if (!requested || resolved) return undefined;
  return requested;
}
