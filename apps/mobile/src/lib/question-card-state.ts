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

/**
 * A question is answered once it has a selected option OR a non-empty note.
 * A bare note is the "Other…" path — a valid free-text answer with no option.
 */
export function questionAnswered(
  selections: SelectionMap,
  notes: NoteMap,
  question: UserInputQuestion,
): boolean {
  const hasSelection = (selections[question.id]?.length ?? 0) > 0;
  const hasNote = (notes[question.id]?.trim().length ?? 0) > 0;
  return hasSelection || hasNote;
}

/** Submit gate: every question in the request needs a selection or a note. */
export function allAnswered(
  selections: SelectionMap,
  notes: NoteMap,
  questions: UserInputQuestion[],
): boolean {
  return questions.every((question) => questionAnswered(selections, notes, question));
}

/**
 * Build the wire answers. A note rides along with a selection as freeText, and
 * a note alone emits the free-text-only shape ({ selectedOptionIds: [], freeText }).
 * A question with neither is omitted.
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
    if (selectedOptionIds.length === 0 && !freeText) continue;
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
