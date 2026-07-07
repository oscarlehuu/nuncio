// Hidden layer for adapt-to-changed-api: (a) packages/logger has no diff; (b)
// each of the 5 migrated call sites passes the correct scope literal (the module
// file name without extension); (c) no new `as any` casts were introduced
// (count vs HEAD unchanged). Run inside the fixture dir.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathUnchanged, git } from './lib/check-helpers.mjs';

const MODULES = ['alpha', 'beta', 'gamma', 'delta', 'epsilon'];

function countAsAny(text) {
  return (text.match(/as any\b/g) ?? []).length;
}

export default function check({ fixtureDir }) {
  const notes = [];

  const loggerClean = pathUnchanged(fixtureDir, 'packages/logger');
  if (!loggerClean) notes.push('packages/logger was modified (must not change)');

  const missingScope = [];
  let asAnyWorktree = 0;
  for (const m of MODULES) {
    let text = '';
    try {
      text = readFileSync(join(fixtureDir, `src/${m}.ts`), 'utf8');
    } catch {
      missingScope.push(m);
      continue;
    }
    // The migrated call must carry the module's own name as scope.
    if (!new RegExp(`scope:\\s*['"\`]${m}['"\`]`).test(text)) missingScope.push(m);
    asAnyWorktree += countAsAny(text);
  }
  if (missingScope.length) notes.push(`missing/incorrect scope literal in: ${missingScope.join(', ')}`);

  // 'as any' count at HEAD across the same files (should be 0 in the fixture).
  let asAnyHead = 0;
  for (const m of MODULES) {
    const res = git(fixtureDir, ['show', `HEAD:src/${m}.ts`]);
    if (res.status === 0) asAnyHead += countAsAny(res.stdout);
  }
  const noNewAny = asAnyWorktree <= asAnyHead;
  if (!noNewAny) notes.push(`introduced 'as any' casts (${asAnyHead} → ${asAnyWorktree})`);

  const pass = loggerClean && missingScope.length === 0 && noNewAny;
  if (pass) notes.push('all 5 call sites migrated with correct scope, logger intact, no new any');
  return { pass, notes };
}
