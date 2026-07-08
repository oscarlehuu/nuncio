import { composeSessionPreamble } from '../../../src/orchestration/session-preamble';
import { EMPTY_PROFILE, type PromptProfile } from '../../../src/prompts/prompt-profile.types';

function profile(sections: PromptProfile['sections']): PromptProfile {
  return { provider: 'x', modelPattern: '*', version: 1, status: 'active', sections };
}

describe('composeSessionPreamble with a profile (D2)', () => {
  it('byte-identical to no-profile when the profile is empty (pass-through invariant)', () => {
    const parts = { brief: 'BRIEF', facts: 'FACTS', prompt: 'PROMPT' };
    const plain = composeSessionPreamble(parts);
    const withEmpty = composeSessionPreamble({ ...parts, profile: EMPTY_PROFILE });
    expect(withEmpty).toBe(plain);
  });

  it('wraps the brief with brief-wrapper and facts with facts-wrapper', () => {
    const out = composeSessionPreamble({
      brief: 'BRIEF',
      facts: 'FACTS',
      prompt: 'PROMPT',
      profile: profile({ briefWrapper: '<b>{{content}}</b>', factsWrapper: '<f>{{content}}</f>' }),
    });
    expect(out).toContain('<b>BRIEF</b>');
    expect(out).toContain('<f>FACTS</f>');
    expect(out.endsWith('PROMPT')).toBe(true);
  });

  it('only wraps the sections that have a wrapper', () => {
    const out = composeSessionPreamble({
      brief: 'BRIEF',
      facts: 'FACTS',
      prompt: 'PROMPT',
      profile: profile({ briefWrapper: 'B[{{content}}]' }), // no facts-wrapper
    });
    expect(out).toContain('B[BRIEF]');
    expect(out).toContain('FACTS'); // facts unwrapped
  });

  it('two providers with different wrappers → different composed strings', () => {
    const parts = { brief: 'BRIEF', prompt: 'PROMPT' };
    const a = composeSessionPreamble({ ...parts, profile: profile({ briefWrapper: 'A: {{content}}' }) });
    const b = composeSessionPreamble({ ...parts, profile: profile({ briefWrapper: 'B: {{content}}' }) });
    expect(a).not.toBe(b);
    expect(a).toContain('A: BRIEF');
    expect(b).toContain('B: BRIEF');
  });

  it('fail-open: a brief-wrapper without a slot appends content and warns', () => {
    const warnings: string[] = [];
    const out = composeSessionPreamble({
      brief: 'BRIEF',
      prompt: 'PROMPT',
      profile: profile({ briefWrapper: 'NO SLOT' }),
      warn: (w) => warnings.push(w),
    });
    expect(out).toContain('NO SLOT');
    expect(out).toContain('BRIEF');
    expect(warnings).toHaveLength(1);
  });
});
