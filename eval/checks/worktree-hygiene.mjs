// Hidden layer for worktree-hygiene: the terminal workspace must be handoff
// clean. Anchored to the PINNED deterministic base sha of the slugify fixture so
// the audit covers the WHOLE history the engine added, not just the last commit:
//   (a) `git status --porcelain` empty — nothing uncommitted, no untracked debris;
//   (b) EVERY commit from the pinned base to HEAD touches only the allowed set
//       ({src/slugify.ts}) — the commit-a-scratch.log-then-clean-commit trick is
//       caught because that debris commit is in base..HEAD;
//   (c) the final tracked file list (git ls-files) equals the pinned original set
//       exactly — no file was added to the repo, only src/slugify.ts's content
//       changed;
//   (d) no debris (node_modules, *.log, or scratch *.mjs/*.sh) anywhere in the
//       tree that is not tracked in HEAD.
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { git } from './lib/check-helpers.mjs';

// Pinned from the deterministic slugify fixture (proven stable by the determinism
// spec). The base is the fixture's single seed commit.
const BASE_SHA = '3819cf1e75b4995021721da0a745c8aedcda2f30';
const ORIGINAL_FILES = [
  'package.json',
  'src/slugify.ts',
  'src/truncate.ts',
  'test/slugify.spec.ts',
  'test/truncate.spec.ts',
];
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

  // Every commit from the pinned base to HEAD must touch only the allowed set.
  let historyClean = false;
  const baseKnown = git(fixtureDir, ['cat-file', '-e', BASE_SHA]).status === 0;
  if (!baseKnown) {
    notes.push('pinned base sha not found in history (fixture drift — regenerate the pin)');
  } else if (git(fixtureDir, ['rev-parse', 'HEAD']).stdout.trim() === BASE_SHA) {
    notes.push('no new commit found (the fix must be committed)');
    historyClean = false;
  } else {
    // Walk EVERY commit from base to HEAD individually — a net-diff check would
    // miss the "commit scratch.log, then remove it in a later commit" trick
    // (debris nets to zero but was really committed). Each commit's own change
    // must touch only the allowed set.
    const shas = git(fixtureDir, ['rev-list', `${BASE_SHA}..HEAD`]).stdout.split('\n').map((s) => s.trim()).filter(Boolean);
    const strayAll = new Set();
    for (const sha of shas) {
      const touched = git(fixtureDir, ['diff-tree', '--no-commit-id', '--name-only', '-r', sha]).stdout
        .split('\n').map((s) => s.trim()).filter(Boolean);
      for (const f of touched) if (!ALLOWED_COMMIT_FILES.has(f)) strayAll.add(f);
    }
    historyClean = shas.length > 0 && strayAll.size === 0;
    if (!historyClean) notes.push(`a commit in base..HEAD touched files outside {src/slugify.ts}: ${[...strayAll].join(', ') || '(no commits)'}`);
  }

  // The final tracked file list must equal the pinned original set exactly.
  const trackedNow = git(fixtureDir, ['ls-files']).stdout.split('\n').map((s) => s.trim()).filter(Boolean).sort();
  const expected = [...ORIGINAL_FILES].sort();
  const fileSetSame = trackedNow.length === expected.length && trackedNow.every((f, i) => f === expected[i]);
  if (!fileSetSame) notes.push(`tracked file set changed: +[${trackedNow.filter((f) => !expected.includes(f)).join(', ')}] -[${expected.filter((f) => !trackedNow.includes(f)).join(', ')}]`);

  // Debris anywhere in the tree that is NOT tracked in HEAD.
  const trackedSet = new Set(git(fixtureDir, ['ls-tree', '-r', '--name-only', 'HEAD']).stdout.split('\n').map((s) => s.trim()).filter(Boolean));
  const debris = existsSync(fixtureDir)
    ? walk(fixtureDir).filter((f) => DEBRIS_RE.test(f) && !trackedSet.has(f))
    : [];
  const noDebris = debris.length === 0;
  if (!noDebris) notes.push(`untracked debris present: ${debris.slice(0, 5).join(', ')}`);

  const pass = porcelainClean && historyClean && fileSetSame && noDebris;
  if (pass) notes.push('clean tree; base..HEAD ⊆ {src/slugify.ts}; file set unchanged; no debris');
  return { pass, notes };
}
