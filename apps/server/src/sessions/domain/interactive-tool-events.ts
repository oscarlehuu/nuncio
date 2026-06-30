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
