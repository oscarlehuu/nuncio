import { formatInteractionAnswers } from '../../../src/sessions/domain/format-interaction-answers';
import type { UserInputQuestion } from '../../../src/sessions/domain/user-input.types';

const singleQuestion: UserInputQuestion[] = [
  {
    id: 'q1',
    prompt: 'Which lane?',
    options: [
      { id: 'a', label: 'Frontend' },
      { id: 'b', label: 'Backend' },
    ],
  },
];

const multiQuestions: UserInputQuestion[] = [
  {
    id: 'q1',
    prompt: 'Which lane?',
    options: [
      { id: 'a', label: 'Frontend' },
      { id: 'b', label: 'Backend' },
    ],
  },
  {
    id: 'q2',
    prompt: 'Priority?',
    options: [
      { id: 'high', label: 'High' },
      { id: 'low', label: 'Low' },
    ],
  },
];

describe('formatInteractionAnswers', () => {
  it('returns Skip when resolvedBy is skip', () => {
    expect(
      formatInteractionAnswers(singleQuestion, { answers: [], resolvedBy: 'skip' }),
    ).toBe('Skip');
  });

  it('returns selected option label for a single question', () => {
    expect(
      formatInteractionAnswers(singleQuestion, {
        answers: [{ questionId: 'q1', selectedOptionIds: ['a'] }],
        resolvedBy: 'user',
      }),
    ).toBe('Frontend');
  });

  it('comma-joins multiple selected options for a single question', () => {
    expect(
      formatInteractionAnswers(
        [{ ...singleQuestion[0]!, allowMultiple: true }],
        {
          answers: [{ questionId: 'q1', selectedOptionIds: ['a', 'b'] }],
          resolvedBy: 'user',
        },
      ),
    ).toBe('Frontend, Backend');
  });

  it('prefers freeText over selected options', () => {
    expect(
      formatInteractionAnswers(singleQuestion, {
        answers: [
          { questionId: 'q1', selectedOptionIds: ['a'], freeText: 'Custom answer' },
        ],
        resolvedBy: 'user',
      }),
    ).toBe('Custom answer');
  });

  it('formats multiple questions as prompt: label lines', () => {
    expect(
      formatInteractionAnswers(multiQuestions, {
        answers: [
          { questionId: 'q1', selectedOptionIds: ['a'] },
          { questionId: 'q2', selectedOptionIds: ['high'] },
        ],
        resolvedBy: 'user',
      }),
    ).toBe('Which lane?: Frontend\nPriority?: High');
  });
});
