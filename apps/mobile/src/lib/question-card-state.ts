import type { UserInputAnswer, UserInputQuestion } from '@nuncio/core/user-input.types';

/** Selected option ids per question id. */
export type SelectionMap = Record<string, string[]>;
/** Free-text note per question id — rides along with the selection on submit. */
export type NoteMap = Record<string, string>;

/**
 * Toggle an option for a question. Multi-select questions accumulate/remove;
 * single-select always collapses to the tapped option (never toggles off, so
 * the answer stays valid once chosen).
 */
export function toggleOption(
  selected: string[],
  optionId: string,
  allowMultiple?: boolean,
): string[] {
  if (allowMultiple) {
    return selected.includes(optionId)
      ? selected.filter((id) => id !== optionId)
      : [...selected, optionId];
  }
  return [optionId];
}

/** A question is answerable-complete once it has at least one selected option. */
export function questionAnswered(selections: SelectionMap, question: UserInputQuestion): boolean {
  return (selections[question.id]?.length ?? 0) > 0;
}

/** Submit gate: every question in the request needs a selection. */
export function allAnswered(selections: SelectionMap, questions: UserInputQuestion[]): boolean {
  return questions.every((question) => questionAnswered(selections, question));
}

/**
 * Build the wire answers. A note with no selection is dropped (the agent asked
 * for a choice); a note alongside a selection rides along as freeText.
 */
export function buildAnswers(
  questions: UserInputQuestion[],
  selections: SelectionMap,
  notes: NoteMap,
): UserInputAnswer[] {
  const answers: UserInputAnswer[] = [];
  for (const question of questions) {
    const selectedOptionIds = selections[question.id] ?? [];
    const freeText = notes[question.id]?.trim();
    // A note only rides along with a chosen option; a bare note is not a valid
    // answer to a question that asked for a choice, so it is dropped.
    if (selectedOptionIds.length === 0) continue;
    answers.push({
      questionId: question.id,
      selectedOptionIds,
      ...(freeText ? { freeText } : {}),
    });
  }
  return answers;
}

/**
 * Single-select, non-final questions advance to the next question on tap so the
 * common case flows without a Next tap. Multi-select waits for an explicit Next
 * (the user may still be picking), and the final question waits for Submit.
 */
export function shouldAutoAdvance(
  question: UserInputQuestion,
  questionIndex: number,
  totalQuestions: number,
): boolean {
  return !question.allowMultiple && questionIndex < totalQuestions - 1;
}

/** 1-based badge label for an option row (1, 2, 3, 4, …). */
export function optionBadge(index: number): string {
  return String(index + 1);
}
