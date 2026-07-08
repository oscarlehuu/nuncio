import { composeSessionPreamble } from '../../../src/orchestration/session-preamble';

describe('composeSessionPreamble', () => {
  it('composes brief → facts → prompt in order', () => {
    const out = composeSessionPreamble({ brief: 'BRIEF', facts: 'FACTS', prompt: 'PROMPT' });
    expect(out.indexOf('BRIEF')).toBeLessThan(out.indexOf('FACTS'));
    expect(out.indexOf('FACTS')).toBeLessThan(out.indexOf('PROMPT'));
    expect(out.endsWith('PROMPT')).toBe(true);
  });

  it('brief only → brief then prompt', () => {
    const out = composeSessionPreamble({ brief: 'BRIEF', prompt: 'PROMPT' });
    expect(out).toContain('BRIEF');
    expect(out).not.toContain('FACTS');
    expect(out.endsWith('PROMPT')).toBe(true);
  });

  it('facts only → facts then prompt', () => {
    const out = composeSessionPreamble({ facts: 'FACTS', prompt: 'PROMPT' });
    expect(out).toContain('FACTS');
    expect(out.endsWith('PROMPT')).toBe(true);
  });

  it('neither → the prompt unchanged', () => {
    expect(composeSessionPreamble({ prompt: 'PROMPT' })).toBe('PROMPT');
  });

  it('ignores empty-string sections', () => {
    expect(composeSessionPreamble({ brief: '', facts: '', prompt: 'PROMPT' })).toBe('PROMPT');
  });
});
