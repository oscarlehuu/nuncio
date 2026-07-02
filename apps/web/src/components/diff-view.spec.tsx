import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DiffView, parseDiffLines } from './diff-view';

const SAMPLE = [
  'diff --git a/a.ts b/a.ts',
  '--- a/a.ts',
  '+++ b/a.ts',
  '@@ -1,2 +1,3 @@',
  '-const a = 1;',
  '+const a = 2;',
  '+const b = 3;',
  ' console.log(a);',
].join('\n');

describe('parseDiffLines', () => {
  it('classifies hunk headers, adds, deletes, meta, and context', () => {
    const kinds = parseDiffLines(SAMPLE).map((line) => line.kind);
    expect(kinds).toEqual(['meta', 'meta', 'meta', 'hunk', 'del', 'add', 'add', 'context']);
  });

  it('does not classify +++/--- file headers as add/del', () => {
    const lines = parseDiffLines('--- a/x\n+++ b/x');
    expect(lines.every((line) => line.kind === 'meta')).toBe(true);
  });

  it('returns no lines for empty input', () => {
    expect(parseDiffLines('')).toEqual([]);
  });
});

describe('DiffView', () => {
  it('renders every diff line', () => {
    render(<DiffView diff={SAMPLE} />);
    expect(screen.getByText('-const a = 1;')).toBeInTheDocument();
    expect(screen.getByText('+const b = 3;')).toBeInTheDocument();
  });

  it('renders a placeholder for empty diffs', () => {
    render(<DiffView diff="" />);
    expect(screen.getByText(/no textual diff/i)).toBeInTheDocument();
  });
});
