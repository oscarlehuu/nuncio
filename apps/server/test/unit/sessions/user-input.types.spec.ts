import { normalizeUserInput } from '../../../src/sessions/domain/user-input.types';

const sampleQuestion = {
  id: 'q1',
  header: 'Scope',
  prompt: 'Which area?',
  options: [{ id: 'a', label: 'Frontend', description: 'UI only' }],
  allowMultiple: false,
};

describe('normalizeUserInput', () => {
  it('parses AskQuestion with array-form questions', () => {
    const result = normalizeUserInput('AskQuestion', {
      title: 'Pick one',
      questions: [sampleQuestion],
    });
    expect(result).toEqual({
      title: 'Pick one',
      questions: [sampleQuestion],
    });
  });

  it('parses questions provided as a JSON string', () => {
    const result = normalizeUserInput('AskQuestion', {
      questions: JSON.stringify([sampleQuestion]),
    });
    expect(result?.questions).toHaveLength(1);
    expect(result?.questions[0]?.options[0]?.description).toBe('UI only');
  });

  it('returns undefined for malformed JSON string questions', () => {
    expect(normalizeUserInput('AskQuestion', { questions: '{not json' })).toBeUndefined();
  });

  it('returns undefined when questions is missing', () => {
    expect(normalizeUserInput('AskQuestion', { title: 'No questions' })).toBeUndefined();
  });

  it('returns undefined when questions is an empty array', () => {
    expect(normalizeUserInput('AskQuestion', { questions: [] })).toBeUndefined();
  });

  it('skips invalid questions and returns undefined when all invalid', () => {
    expect(
      normalizeUserInput('AskQuestion', {
        questions: [{ id: 'q1' }, { prompt: 'missing id', options: [] }],
      }),
    ).toBeUndefined();
  });

  it('skips options missing a label and numbers options without ids by position', () => {
    const result = normalizeUserInput('AskQuestion', {
      questions: [
        {
          id: 'q1',
          prompt: 'Pick',
          options: [{ id: 'ok', label: 'Good' }, { id: 'bad' }, { label: 'no id' }],
        },
      ],
    });
    expect(result?.questions[0]?.options).toEqual([
      { id: 'ok', label: 'Good' },
      { id: '3', label: 'no id' },
    ]);
  });

  it('defaults question and option ids by position', () => {
    const result = normalizeUserInput('AskQuestion', {
      questions: [
        { prompt: 'Pick', options: [{ label: 'A' }, { label: 'B' }] },
      ],
    });
    expect(result?.questions[0]).toEqual({
      id: 'q1',
      prompt: 'Pick',
      options: [
        { id: '1', label: 'A' },
        { id: '2', label: 'B' },
      ],
    });
  });

  it('keeps generated question and option ids unique when positions collide with explicit ids', () => {
    const result = normalizeUserInput('AskUserQuestion', {
      questions: [
        {
          id: 'q2',
          prompt: 'First',
          options: [
            { id: '2', label: 'Alpha' },
            { label: 'Beta' },
          ],
        },
        {
          prompt: 'Second',
          options: [{ label: 'Gamma' }],
        },
      ],
    });

    expect(result?.questions.map((question) => question.id)).toEqual(['q2', 'q2-2']);
    expect(result?.questions[0]?.options.map((option) => option.id)).toEqual(['2', '2-2']);
  });

  it('parses askquestion lowercase SDK tool name', () => {
    const result = normalizeUserInput('askquestion', { questions: [sampleQuestion] });
    expect(result?.questions).toHaveLength(1);
  });

  it('parses AskUserQuestion with the same shape', () => {
    const result = normalizeUserInput('AskUserQuestion', { questions: [sampleQuestion] });
    expect(result?.questions).toHaveLength(1);
  });

  it('returns undefined for unknown tool names', () => {
    expect(normalizeUserInput('Read', { questions: [sampleQuestion] })).toBeUndefined();
  });
});
