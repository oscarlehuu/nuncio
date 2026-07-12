import type { InteractionResponse } from '../../agents/agents.types';
import type { UserInputQuestion } from './user-input.types';

function formatOneAnswer(
  question: UserInputQuestion,
  response: InteractionResponse,
): string {
  const answer = response.answers.find((item) => item.questionId === question.id);
  if (!answer) return '';

  const freeText = answer.freeText?.trim();
  // Options are numbered by position — echo the number so the agent can map
  // "Option 2" style replies back to its own option list.
  const selections = answer.selectedOptionIds
    .map((id) => {
      const index = question.options.findIndex((option) => option.id === id);
      if (index < 0) return undefined;
      return `Option ${index + 1} — ${question.options[index]!.label}`;
    })
    .filter((label): label is string => label !== undefined);

  if (selections.length === 0) return freeText ?? '';
  const joined = selections.join(', ');
  return freeText ? `${joined} (note: ${freeText})` : joined;
}

export function formatInteractionAnswers(
  questions: UserInputQuestion[],
  response: InteractionResponse,
): string {
  if (response.resolvedBy === 'skip') return 'Skip';

  if (questions.length === 1) {
    return formatOneAnswer(questions[0]!, response);
  }

  return questions
    .map((question) => {
      const formatted = formatOneAnswer(question, response);
      return formatted ? `${question.prompt}: ${formatted}` : null;
    })
    .filter((line): line is string => line !== null)
    .join('\n');
}
