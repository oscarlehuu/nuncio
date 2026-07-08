import { describe, expect, it } from 'bun:test';
import { parseUnifiedDiff } from '../../../../src/sessions/diff/diff-parse';

/**
 * Structured diff parse (rung 3 sub-phase D) — pure, RED until implemented. Folds
 * git's raw unified output into per-file entries with typed hunk lines. Fixtures
 * are literal unified-diff text (deterministic, no repo needed here).
 */
const MODIFIED = `diff --git a/src/x.ts b/src/x.ts
index 111..222 100644
--- a/src/x.ts
+++ b/src/x.ts
@@ -1,3 +1,4 @@
 const a = 1;
-const b = 2;
+const b = 3;
+const c = 4;
 const d = 5;
`;

describe('parseUnifiedDiff', () => {
  it('parses a modified file into hunks with typed lines', () => {
    const files = parseUnifiedDiff(MODIFIED);
    expect(files).toHaveLength(1);
    const f = files[0]!;
    expect(f.path).toBe('src/x.ts');
    expect(f.status).toBe('modified');
    expect(f.hunks).toHaveLength(1);
    const hunk = f.hunks[0]!;
    expect(hunk.oldStart).toBe(1);
    expect(hunk.newStart).toBe(1);
    expect(hunk.lines.map((l) => l.kind)).toEqual(['context', 'del', 'add', 'add', 'context']);
    expect(f.additions).toBe(2);
    expect(f.deletions).toBe(1);
  });

  it('splits multiple files into one entry each', () => {
    const raw = MODIFIED + `diff --git a/src/y.ts b/src/y.ts
--- a/src/y.ts
+++ b/src/y.ts
@@ -1 +1 @@
-old
+new
`;
    const files = parseUnifiedDiff(raw);
    expect(files.map((f) => f.path)).toEqual(['src/x.ts', 'src/y.ts']);
  });

  it('classifies an added (new) file', () => {
    const raw = `diff --git a/new.ts b/new.ts
new file mode 100644
index 000..abc
--- /dev/null
+++ b/new.ts
@@ -0,0 +1,2 @@
+line one
+line two
`;
    const f = parseUnifiedDiff(raw)[0]!;
    expect(f.status).toBe('added');
    expect(f.additions).toBe(2);
    expect(f.deletions).toBe(0);
  });

  it('classifies a deleted file', () => {
    const raw = `diff --git a/gone.ts b/gone.ts
deleted file mode 100644
index abc..000
--- a/gone.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-line one
-line two
`;
    const f = parseUnifiedDiff(raw)[0]!;
    expect(f.status).toBe('removed');
  });

  it('classifies a renamed file with oldPath', () => {
    const raw = `diff --git a/old-name.ts b/new-name.ts
similarity index 95%
rename from old-name.ts
rename to new-name.ts
--- a/old-name.ts
+++ b/new-name.ts
@@ -1 +1 @@
-a
+b
`;
    const f = parseUnifiedDiff(raw)[0]!;
    expect(f.status).toBe('renamed');
    expect(f.oldPath).toBe('old-name.ts');
    expect(f.path).toBe('new-name.ts');
  });

  it('flags a binary file with no inline hunks', () => {
    const raw = `diff --git a/logo.png b/logo.png
index 111..222 100644
Binary files a/logo.png and b/logo.png differ
`;
    const f = parseUnifiedDiff(raw)[0]!;
    expect(f.status).toBe('binary');
    expect(f.hunks).toEqual([]);
  });

  it('surfaces an untracked/new file (added-style), not dropped', () => {
    // git diff --no-index against /dev/null for an untracked file.
    const raw = `diff --git a/untracked.ts b/untracked.ts
new file mode 100644
index 000..abc
--- /dev/null
+++ b/untracked.ts
@@ -0,0 +1 @@
+brand new
`;
    const files = parseUnifiedDiff(raw);
    expect(files).toHaveLength(1);
    expect(files[0]!.status).toBe('added');
  });

  it('parses multiple hunks in one file', () => {
    const raw = `diff --git a/multi.ts b/multi.ts
--- a/multi.ts
+++ b/multi.ts
@@ -1,2 +1,2 @@
 a
-b
+B
@@ -10,2 +10,2 @@
 x
-y
+Y
`;
    const f = parseUnifiedDiff(raw)[0]!;
    expect(f.hunks).toHaveLength(2);
    expect(f.hunks[1]!.oldStart).toBe(10);
  });

  it('an empty diff → no files', () => {
    expect(parseUnifiedDiff('')).toEqual([]);
    expect(parseUnifiedDiff('   \n')).toEqual([]);
  });
});
