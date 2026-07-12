import { describe, expect, it } from 'vitest';
import type { UserInputQuestion } from '@nuncio/core/user-input.types';
import {
  allAnswered,
  buildAnswers,
  optionBadge,
  questionAnswered,
  shouldAutoAdvance,
  toggleOption,
} from './question-card-state';

const single: UserInputQuestion = {
  id: 'q1',
  prompt: 'Pick one',
  options: [
    { id: 'a', label: 'A' },
    { id: 'b', label: 'B' },
  ],
};

const multi: UserInputQuestion = {
  id: 'q2',
  prompt: 'Pick some',
  allowMultiple: true,
  options: [
    { id: 'x', label: 'X' },
    { id: 'y', label: 'Y' },
  ],
};

describe('toggleOption', () => {
  it('single-select collapses to the tapped option', () => {
    expect(toggleOption(['a'], 'b', false)).toEqual(['b']);
  });

  it('single-select keeps a re-tapped option selected', () => {
    expect(toggleOption(['a'], 'a', false)).toEqual(['a']);
  });

  it('multi-select accumulates then removes', () => {
    expect(toggleOption(['x'], 'y', true)).toEqual(['x', 'y']);
    expect(toggleOption(['x', 'y'], 'x', true)).toEqual(['y']);
  });
});

describe('answered gates', () => {
  it('questionAnswered needs a selection', () => {
    expect(questionAnswered({}, single)).toBe(false);
    expect(questionAnswered({ q1: ['a'] }, single)).toBe(true);
  });

  it('allAnswered requires every question chosen', () => {
    expect(allAnswered({ q1: ['a'] }, [single, multi])).toBe(false);
    expect(allAnswered({ q1: ['a'], q2: ['x'] }, [single, multi])).toBe(true);
  });
});

describe('buildAnswers', () => {
  it('attaches a note as freeText alongside a selection', () => {
    const answers = buildAnswers([single], { q1: ['a'] }, { q1: '  keep it small  ' });
    expect(answers).toEqual([{ questionId: 'q1', selectedOptionIds: ['a'], freeText: 'keep it small' }]);
  });

  it('drops a note with no selection', () => {
    expect(buildAnswers([single], {}, { q1: 'lonely note' })).toEqual([]);
  });

  it('omits freeText when the note is blank', () => {
    const answers = buildAnswers([single], { q1: ['b'] }, { q1: '   ' });
    expect(answers).toEqual([{ questionId: 'q1', selectedOptionIds: ['b'] }]);
  });
});

describe('shouldAutoAdvance', () => {
  it('advances single-select non-final questions', () => {
    expect(shouldAutoAdvance(single, 0, 2)).toBe(true);
  });

  it('waits on multi-select', () => {
    expect(shouldAutoAdvance(multi, 0, 2)).toBe(false);
  });

  it('waits on the final question for an explicit submit', () => {
    expect(shouldAutoAdvance(single, 1, 2)).toBe(false);
  });
});

describe('optionBadge', () => {
  it('is 1-based', () => {
    expect(optionBadge(0)).toBe('1');
    expect(optionBadge(3)).toBe('4');
  });
});
