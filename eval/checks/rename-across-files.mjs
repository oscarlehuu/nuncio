// Hidden layer for rename-across-files: (a) no word-boundary `getUser` remains in
// src/ or test/; (b) the unrelated getUserAgent DEFINITION line survives
// byte-identical (a line anchor, not a raw grep — renaming it but leaving a
// comment that mentions it does not pass); (c) the log string was updated to
// fetchUser; (d) the bundle still builds. Note: this task legitimately updates
// test imports, so test/ is NOT asserted unchanged (unlike the src-only tasks).
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { headLineSurvives } from './lib/check-helpers.mjs';

function grepWordCount(dir, word, paths) {
  // git grep is word-boundary aware and only scans tracked+worktree files.
  const res = spawnSync('grep', ['-rwn', word, ...paths], { cwd: dir, encoding: 'utf8', stdio: 'pipe' });
  // grep exits 1 with no matches (that's what we want here).
  return res.stdout ? res.stdout.split('\n').filter(Boolean).length : 0;
}

export default function check({ fixtureDir }) {
  const notes = [];

  const remaining = grepWordCount(fixtureDir, 'getUser', ['src', 'test']);
  if (remaining > 0) notes.push(`getUser still present ${remaining}x (must be renamed everywhere)`);

  // Anchor to the exact HEAD definition line, so the symbol truly survives.
  const httpOk = headLineSurvives(fixtureDir, 'src/http.ts', /export function getUserAgent\b/);
  if (!httpOk) notes.push('getUserAgent definition line in src/http.ts was altered (must not be renamed)');

  let logOk = false;
  try {
    logOk = /fetchUser failed/.test(readFileSync(join(fixtureDir, 'src/service/profile.ts'), 'utf8'));
  } catch {
    logOk = false;
  }
  if (!logOk) notes.push("log string 'getUser failed' was not updated to 'fetchUser failed'");

  const build = spawnSync('bun', ['build', '--target=bun', 'src/index.ts'], {
    cwd: fixtureDir,
    encoding: 'utf8',
    stdio: 'pipe',
  });
  const buildOk = build.status === 0;
  if (!buildOk) notes.push(`bun build failed: ${(build.stderr || build.stdout || '').slice(-200)}`);

  const pass = remaining === 0 && httpOk && logOk && buildOk;
  if (pass) notes.push('rename complete: no getUser, getUserAgent intact, log updated, build green');
  return { pass, notes };
}
