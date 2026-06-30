import type { InteractionResponse } from '../../agents/agents.types';
import type { UserInputQuestion } from './user-input.types';

function formatOneAnswer(
  question: UserInputQuestion,
  response: InteractionResponse,
): string {
  const answer = response.answers.find((item) => item.questionId === question.id);
  if (!answer) return '';

  const freeText = answer.freeText?.trim();
  if (freeText) return freeText;

  const labels = answer.selectedOptionIds
    .map((id) => question.options.find((option) => option.id === id)?.label)
    .filter((label): label is string => label !== undefined);

  return labels.join(', ');
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
