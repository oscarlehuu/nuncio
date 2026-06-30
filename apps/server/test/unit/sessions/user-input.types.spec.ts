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

  it('skips options missing id or label', () => {
    const result = normalizeUserInput('AskQuestion', {
      questions: [
        {
          id: 'q1',
          prompt: 'Pick',
          options: [{ id: 'ok', label: 'Good' }, { id: 'bad' }, { label: 'no id' }],
        },
      ],
    });
    expect(result?.questions[0]?.options).toEqual([{ id: 'ok', label: 'Good' }]);
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
