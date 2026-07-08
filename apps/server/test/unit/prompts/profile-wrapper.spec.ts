import { applyWrapper } from '../../../src/prompts/profile-wrapper';

describe('applyWrapper', () => {
  it('returns the content unchanged when the wrapper is absent/empty', () => {
    expect(applyWrapper(undefined, 'CONTENT', () => {})).toBe('CONTENT');
    expect(applyWrapper('', 'CONTENT', () => {})).toBe('CONTENT');
  });

  it('replaces the {{content}} slot', () => {
    expect(applyWrapper('before {{content}} after', 'X', () => {})).toBe('before X after');
  });

  it('replaces ALL {{content}} occurrences', () => {
    expect(applyWrapper('{{content}} and {{content}}', 'X', () => {})).toBe('X and X');
  });

  it('fail-open: a wrapper with no slot appends the content after the wrapper text, and warns', () => {
    const warnings: string[] = [];
    const out = applyWrapper('WRAPPER TEXT', 'CONTENT', (w) => warnings.push(w));
    expect(out).toBe('WRAPPER TEXT\n\nCONTENT');
    expect(warnings).toHaveLength(1);
  });

  it('empty content still substitutes cleanly', () => {
    expect(applyWrapper('a {{content}} b', '', () => {})).toBe('a  b');
  });
});
