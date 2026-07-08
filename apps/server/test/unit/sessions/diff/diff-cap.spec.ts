import { describe, expect, it } from 'bun:test';
import { capDiff, MAX_FILE_DIFF_LINES } from '../../../../src/sessions/diff/diff-parse';
import type { DiffFile, DiffHunk } from '../../../../src/sessions/diff/session-diff.types';

/**
 * Phone-safe diff caps (rung 3 sub-phase D) — pure, RED until implemented. Every
 * omission is a LABELLED marker, never a silent drop.
 */
function hunk(lines: number): DiffHunk {
  return {
    header: `@@ -1,${lines} +1,${lines} @@`,
    oldStart: 1, oldLines: lines, newStart: 1, newLines: lines,
    lines: Array.from({ length: lines }, () => ({ kind: 'add' as const, text: 'x' })),
  };
}

function file(over: Partial<DiffFile>): DiffFile {
  return {
    path: over.path ?? 'f.ts', oldPath: over.oldPath ?? null, status: over.status ?? 'modified',
    additions: over.additions ?? 1, deletions: over.deletions ?? 0, hunks: over.hunks ?? [hunk(1)],
    collapsed: over.collapsed,
  };
}

describe('capDiff', () => {
  it('collapses an oversized file (hunks withheld, honest too-large marker)', () => {
    const big = file({ path: 'big.ts', hunks: [hunk(MAX_FILE_DIFF_LINES + 10)] });
    const out = capDiff([big]);
    const f = out.files.find((x) => x.path === 'big.ts')!;
    expect(f.collapsed).toBe('too-large');
    expect(f.hunks).toEqual([]);
    // Still listed with its counts — present, not dropped.
    expect(out.files.some((x) => x.path === 'big.ts')).toBe(true);
  });

  it('collapses a lockfile by default (present, hunks withheld)', () => {
    for (const name of ['package-lock.json', 'bun.lock', 'yarn.lock', 'pnpm-lock.yaml']) {
      const out = capDiff([file({ path: name, hunks: [hunk(5)] })]);
      const f = out.files.find((x) => x.path === name)!;
      expect(f.collapsed).toBe('lockfile');
      expect(f.hunks).toEqual([]);
    }
  });

  it('collapses a binary file (no inline, marker set)', () => {
    const out = capDiff([file({ path: 'logo.png', status: 'binary', hunks: [] })]);
    expect(out.files[0]!.collapsed).toBe('binary');
  });

  it('a small normal file keeps its hunks', () => {
    const out = capDiff([file({ path: 'ok.ts', hunks: [hunk(3)] })]);
    expect(out.files[0]!.collapsed).toBeUndefined();
    expect(out.files[0]!.hunks).toHaveLength(1);
  });

  it('drops files past the hard total cap into omittedFiles (truncated, labelled)', () => {
    // Many large files → the total-bytes ceiling drops the tail.
    const many = Array.from({ length: 500 }, (_, i) => file({ path: `f${i}.ts`, hunks: [hunk(1500)] }));
    const out = capDiff(many);
    expect(out.truncated).toBe(true);
    expect(out.omittedFiles).toBeGreaterThan(0);
    expect(out.files.length + out.omittedFiles).toBe(many.length);
  });

  it('an empty file list → empty, non-truncated', () => {
    expect(capDiff([])).toEqual({ files: [], truncated: false, omittedFiles: 0 });
  });
});
