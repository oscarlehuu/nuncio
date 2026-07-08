import { renderHandoffBrief } from '../../../src/orchestration/handoff-brief.renderer';
import { validateHandoffBrief } from '../../../src/orchestration/handoff-brief.validate';

describe('validateHandoffBrief', () => {
  it('accepts a well-formed brief', () => {
    const brief = validateHandoffBrief({
      goal: 'do it',
      constraints: ['no deps'],
      files: ['src/a.ts'],
      workspace: { branch: 'main', headSha: 'abc', baseBranch: null, dirtyFiles: ['src/a.ts'], diffStat: null },
    });
    expect(brief.goal).toBe('do it');
  });

  it('rejects a missing or empty goal', () => {
    expect(() => validateHandoffBrief({})).toThrow(/goal/);
    expect(() => validateHandoffBrief({ goal: '   ' })).toThrow(/goal/);
  });

  it('rejects list fields that are not arrays of strings', () => {
    expect(() => validateHandoffBrief({ goal: 'g', constraints: 'nope' })).toThrow(/constraints/);
    expect(() => validateHandoffBrief({ goal: 'g', files: [1, 2] })).toThrow(/files/);
  });

  describe('workspace shape', () => {
    it('rejects a non-object workspace', () => {
      expect(() => validateHandoffBrief({ goal: 'g', workspace: 'nope' })).toThrow(/workspace/);
    });

    it('rejects a non-string branch', () => {
      expect(() =>
        validateHandoffBrief({ goal: 'g', workspace: { branch: 42, headSha: null, baseBranch: null, dirtyFiles: [], diffStat: null } }),
      ).toThrow(/workspace.branch/);
    });

    it('rejects dirtyFiles that are not an array of strings', () => {
      expect(() =>
        validateHandoffBrief({ goal: 'g', workspace: { branch: null, headSha: null, baseBranch: null, dirtyFiles: 'oops', diffStat: null } }),
      ).toThrow(/dirtyFiles/);
    });

    it('accepts null workspace', () => {
      expect(validateHandoffBrief({ goal: 'g', workspace: null }).workspace).toBeNull();
    });
  });

  describe('per-field byte caps', () => {
    it('rejects a goal over 500 bytes', () => {
      expect(() => validateHandoffBrief({ goal: 'g'.repeat(501) })).toThrow(/goal/);
    });

    it('rejects a verifyCommand over 300 bytes', () => {
      expect(() => validateHandoffBrief({ goal: 'g', verifyCommand: 'v'.repeat(301) })).toThrow(/verifyCommand/);
    });

    it('rejects too many doneCriteria items', () => {
      expect(() =>
        validateHandoffBrief({ goal: 'g', doneCriteria: Array.from({ length: 11 }, () => 'x') }),
      ).toThrow(/doneCriteria/);
    });

    it('rejects a doneCriteria item over 200 bytes', () => {
      expect(() => validateHandoffBrief({ goal: 'g', doneCriteria: ['x'.repeat(201)] })).toThrow(/doneCriteria/);
    });

    it('rejects too many constraints items', () => {
      expect(() =>
        validateHandoffBrief({ goal: 'g', constraints: Array.from({ length: 21 }, () => 'x') }),
      ).toThrow(/constraints/);
    });

    it('rejects a constraints item over 300 bytes', () => {
      expect(() => validateHandoffBrief({ goal: 'g', constraints: ['x'.repeat(301)] })).toThrow(/constraints/);
    });
  });

  it('worst-case valid input still renders within the 2KB budget', () => {
    // Every field at its per-field maximum. The per-field caps alone total more
    // than 2 KB of protected content (goal 500 + verifyCommand 300 + 10×200),
    // so the renderer backstop is what guarantees the ceiling — assert the hard
    // invariant (≤ 2048 bytes) that must hold for ANY validated input.
    const brief = validateHandoffBrief({
      goal: 'g'.repeat(500),
      verifyCommand: 'v'.repeat(300),
      doneCriteria: Array.from({ length: 10 }, () => 'd'.repeat(200)),
      // A couple of droppable entries too — they get shed by the ladder before
      // the protected fields ever threaten the budget.
      constraints: Array.from({ length: 5 }, () => 'c'.repeat(300)),
      files: Array.from({ length: 5 }, () => 'f'.repeat(200)),
    });
    const rendered = renderHandoffBrief(brief);
    expect(new TextEncoder().encode(rendered).byteLength).toBeLessThanOrEqual(2048);
    expect(rendered.startsWith('## Handoff brief')).toBe(true);
  });
});
