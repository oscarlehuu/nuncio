import { buildUserInputRequestedPayload } from '../../../src/sessions/domain/interactive-tool-events';

const sampleQuestion = {
  id: 'q1',
  prompt: 'Pick one',
  options: [{ id: 'a', label: 'A' }],
};

describe('buildUserInputRequestedPayload', () => {
  it('builds payload for askquestion (lowercase SDK name)', () => {
    const payload = buildUserInputRequestedPayload(
      'askquestion',
      { title: 'Title', questions: [sampleQuestion] },
      'call-1',
    );
    expect(payload).toEqual({
      requestId: 'call-1',
      title: 'Title',
      questions: [sampleQuestion],
    });
  });

  it('returns undefined for non-interactive tools', () => {
    expect(buildUserInputRequestedPayload('bash', { cmd: 'ls' }, 'c1')).toBeUndefined();
  });

  it('returns undefined when questions are malformed', () => {
    expect(buildUserInputRequestedPayload('askquestion', { questions: '{bad' }, 'c1')).toBeUndefined();
  });
});
