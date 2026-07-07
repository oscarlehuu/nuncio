// Shared helpers for runner-side hidden checks. These run OUTSIDE the fixture,
// after the task terminates, and may shell out to git inside the fixture dir to
// inspect the final working-tree/commit state.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Run git in `dir`; returns { status, stdout, stderr }. Never throws. */
export function git(dir, args) {
  const res = spawnSync('git', args, { cwd: dir, encoding: 'utf8', stdio: 'pipe' });
  return { status: res.status ?? 1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

/** Content of a path at HEAD (the committed blob), or null if absent. */
export function showHead(dir, relPath) {
  const res = git(dir, ['show', `HEAD:${relPath}`]);
  return res.status === 0 ? res.stdout : null;
}

/** Working-tree content of a path, or null if absent. */
export function readWorktree(dir, relPath) {
  try {
    return readFileSync(join(dir, relPath), 'utf8');
  } catch {
    return null;
  }
}

/** True when `relPath` (dir or file) has no working-tree diff vs HEAD. */
export function pathUnchanged(dir, relPath) {
  return git(dir, ['diff', '--quiet', 'HEAD', '--', relPath]).status === 0;
}

/** The set of paths with a working-tree diff vs HEAD (porcelain, tracked). */
export function changedPaths(dir) {
  const res = git(dir, ['diff', '--name-only', 'HEAD']);
  return res.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
}

/**
 * True when the tracked `test/` directory is byte-identical to HEAD — no
 * assertion was rewritten to "pass". Shared across every task whose real work
 * lives in src/, so editing the failing test to make the visible suite green
 * (a lazy-engine bypass) is caught by the hidden layer.
 */
export function testDirUnchanged(dir) {
  return git(dir, ['diff', '--quiet', 'HEAD', '--', 'test']).status === 0;
}

/**
 * True when the exact line from HEAD's `relPath` matching `pattern` survives
 * byte-identical in the working tree. A line-level anchor (not whole-file, not a
 * raw grep) so "rename the definition but leave a comment mentioning it" cannot
 * pass a preservation check.
 */
export function headLineSurvives(dir, relPath, pattern) {
  const head = showHead(dir, relPath);
  const now = readWorktree(dir, relPath);
  if (head === null || now === null) return false;
  const headLine = head.split('\n').find((l) => pattern.test(l));
  if (headLine === undefined) return false;
  const nowLines = new Set(now.split('\n'));
  return nowLines.has(headLine);
}

/**
 * Budget accounting for the working-tree state vs HEAD, hardened against two
 * bypasses: a BINARY change (numstat reports '-'\t'-') is an automatic violation
 * (returns Infinity, no engine sneaks bytes past a line budget as a blob), and
 * UNTRACKED files count their own line totals (an engine can dodge a tracked
 * diff by writing brand-new files). `allowUntracked` names paths that are the
 * task's legitimate deliverable (e.g. a report) and are exempt from the budget.
 */
export function diffLineBudget(dir, { allowUntracked = [] } = {}) {
  let total = 0;

  const tracked = git(dir, ['diff', 'HEAD', '--numstat']);
  for (const line of tracked.stdout.split('\n')) {
    const m = line.trim().match(/^(\S+)\s+(\S+)\s+(.+)$/);
    if (!m) continue;
    if (m[1] === '-' || m[2] === '-') return Infinity; // binary change
    total += Number(m[1]) + Number(m[2]);
  }

  // Untracked files (git diff --numstat vs HEAD does not see them).
  const others = git(dir, ['ls-files', '--others', '--exclude-standard']);
  for (const rel of others.stdout.split('\n').map((s) => s.trim()).filter(Boolean)) {
    if (allowUntracked.some((p) => rel === p || rel.startsWith(`${p}/`))) continue;
    const text = readWorktree(dir, rel);
    if (text === null) continue;
    if (text.includes('\0')) return Infinity; // untracked binary
    // Count non-empty-file lines the way numstat counts additions.
    total += text.length === 0 ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
  }
  return total;
}
