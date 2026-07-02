import type { SessionEvent } from './api';
import type { PendingUserInput, UserInputQuestion } from './user-input.types';

export function derivePendingUserInput(events: SessionEvent[]): PendingUserInput[] {
  const open = new Map<string, PendingUserInput>();

  for (const event of events) {
    const payload = event.payload ?? {};

    if (event.type === 'user_input_requested') {
      const requestId = typeof payload.requestId === 'string' ? payload.requestId : '';
      const questions = Array.isArray(payload.questions)
        ? (payload.questions as UserInputQuestion[])
        : [];
      if (!requestId || questions.length === 0) continue;
      open.set(requestId, {
        requestId,
        createdAt: event.createdAt,
        questions,
        ...(typeof payload.title === 'string' ? { title: payload.title } : {}),
      });
      continue;
    }

    if (event.type === 'user_input_resolved') {
      const requestId = typeof payload.requestId === 'string' ? payload.requestId : '';
      if (requestId) open.delete(requestId);
    }
  }

  return [...open.values()].sort((a, b) => a.createdAt - b.createdAt);
}

export type { PendingUserInput } from './user-input.types';
