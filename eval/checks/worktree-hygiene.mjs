// Hidden layer for worktree-hygiene: the terminal workspace must be handoff
// clean. (a) `git status --porcelain` is empty — nothing uncommitted, no
// untracked debris; (b) the engine's commit touched only files within
// {src/slugify.ts} (it committed the fix, not scratch files); (c) no debris
// (node_modules, *.log, or scratch *.mjs/*.sh) anywhere in the tree that is not
// in HEAD. Because the fix is committed, (b) compares the tip commit against the
// seed (HEAD~1).
import { existsSync } from 'node:fs';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { git } from './lib/check-helpers.mjs';

const ALLOWED_COMMIT_FILES = new Set(['src/slugify.ts']);
const DEBRIS_RE = /(^|\/)(node_modules)(\/|$)|\.(log|mjs|sh)$/;

function walk(dir, rel = '') {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (name === '.git') continue;
    const abs = join(dir, name);
    const r = rel ? `${rel}/${name}` : name;
    if (statSync(abs).isDirectory()) out.push(...walk(abs, r));
    else out.push(r);
  }
  return out;
}

export default function check({ fixtureDir }) {
  const notes = [];

  const porcelainClean = git(fixtureDir, ['status', '--porcelain']).stdout.trim() === '';
  if (!porcelainClean) notes.push('working tree is not clean (git status --porcelain non-empty)');

  // The commit's file list (tip vs seed) must be a subset of the allowed set.
  const count = Number(git(fixtureDir, ['rev-list', '--count', 'HEAD']).stdout.trim());
  let commitClean = false;
  if (count < 2) {
    notes.push('no new commit found (the fix must be committed)');
  } else {
    const files = git(fixtureDir, ['diff', '--name-only', 'HEAD~1', 'HEAD']).stdout.split('\n').map((s) => s.trim()).filter(Boolean);
    const stray = files.filter((f) => !ALLOWED_COMMIT_FILES.has(f));
    commitClean = files.length > 0 && stray.length === 0;
    if (!commitClean) notes.push(`commit touched files outside {src/slugify.ts}: ${stray.join(', ') || '(empty commit)'}`);
  }

  // Debris anywhere in the tree that is NOT tracked in HEAD.
  const tracked = new Set(git(fixtureDir, ['ls-tree', '-r', '--name-only', 'HEAD']).stdout.split('\n').map((s) => s.trim()).filter(Boolean));
  const debris = existsSync(fixtureDir)
    ? walk(fixtureDir).filter((f) => DEBRIS_RE.test(f) && !tracked.has(f))
    : [];
  const noDebris = debris.length === 0;
  if (!noDebris) notes.push(`untracked debris present: ${debris.slice(0, 5).join(', ')}`);

  const pass = porcelainClean && commitClean && noDebris;
  if (pass) notes.push('clean tree, commit ⊆ {src/slugify.ts}, no debris');
  return { pass, notes };
}
