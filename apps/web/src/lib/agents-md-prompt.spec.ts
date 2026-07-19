import { describe, expect, it } from 'vitest';
import { AGENTS_MD_GENERATION_PROMPT } from './agents-md-prompt';

describe('AGENTS_MD_GENERATION_PROMPT', () => {
  it('is a reviewable /init prompt that asks for a verified AGENTS.md', () => {
    expect(AGENTS_MD_GENERATION_PROMPT).toContain('AGENTS.md');
    expect(AGENTS_MD_GENERATION_PROMPT).toContain('operating manual');
    expect(AGENTS_MD_GENERATION_PROMPT).toMatch(/verify every command/i);
    expect(AGENTS_MD_GENERATION_PROMPT).toMatch(/under ~150 lines/i);
    expect(AGENTS_MD_GENERATION_PROMPT).toMatch(/gotchas/i);
    // Prefill only — never instruct the agent to skip the user review step.
    expect(AGENTS_MD_GENERATION_PROMPT.toLowerCase()).not.toContain('do not wait');
    expect(AGENTS_MD_GENERATION_PROMPT.length).toBeGreaterThan(200);
    expect(AGENTS_MD_GENERATION_PROMPT.length).toBeLessThan(4000);
  });
});
