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

/** Summed added+removed across the working-tree diff vs HEAD (numstat). */
export function diffLineBudget(dir) {
  const res = git(dir, ['diff', 'HEAD', '--numstat']);
  let total = 0;
  for (const line of res.stdout.split('\n')) {
    const m = line.trim().match(/^(\d+|-)\s+(\d+|-)\s+/);
    if (!m) continue;
    const added = m[1] === '-' ? 0 : Number(m[1]);
    const removed = m[2] === '-' ? 0 : Number(m[2]);
    total += added + removed;
  }
  return total;
}
