import { describe, expect, it } from 'bun:test';
import { BadRequestException } from '@nestjs/common';
import { buildDiffCommentSteer, MAX_STEER_HUNK_CHARS } from '../../../../src/sessions/diff/diff-comment';

/**
 * Comment-to-steer text builder (rung 3 sub-phase D) — pure, RED until
 * implemented. A delimited file:line + capped hunk + comment block that rides the
 * existing rung-1 steer path.
 */
describe('buildDiffCommentSteer', () => {
  const base = {
    path: 'src/utils/x.ts',
    startLine: 10,
    endLine: 14,
    hunk: '@@ -10,4 +10,4 @@\n const a = 1;\n-const b = helperInline();\n+const b = helper();\n',
    comment: 'this helper already exists in utils/x.ts — use it',
  };

  it('carries file:line context, the hunk, and the comment in a delimited block', () => {
    const text = buildDiffCommentSteer(base);
    expect(text).toContain('src/utils/x.ts:10-14'); // file:line
    expect(text).toContain('helper()'); // the hunk text
    expect(text).toContain('this helper already exists'); // the comment
    // The comment (the founder's ask) comes AFTER the hunk context.
    expect(text.indexOf('this helper already exists')).toBeGreaterThan(text.indexOf('helper()'));
  });

  it('caps a long hunk with a truncation marker', () => {
    const longHunk = '@@ -1,9999 +1,9999 @@\n' + 'x\n'.repeat(MAX_STEER_HUNK_CHARS);
    const text = buildDiffCommentSteer({ ...base, hunk: longHunk });
    expect(text.length).toBeLessThan(longHunk.length + 500); // hunk was capped
    expect(text).toMatch(/truncat|…|\.\.\./i); // an honest marker
  });

  it('rejects an empty comment at the boundary', () => {
    expect(() => buildDiffCommentSteer({ ...base, comment: '   ' })).toThrow(BadRequestException);
    expect(() => buildDiffCommentSteer({ ...base, comment: '' })).toThrow(BadRequestException);
  });

  it('handles a single-line range (start == end)', () => {
    const text = buildDiffCommentSteer({ ...base, startLine: 7, endLine: 7 });
    expect(text).toContain('src/utils/x.ts:7');
  });
});
