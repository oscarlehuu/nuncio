// Hidden layer for rename-across-files: (a) no word-boundary `getUser` remains in
// src/ or test/; (b) the unrelated getUserAgent survives in src/http.ts; (c) the
// log string that named the function was updated to fetchUser; (d) the bundle
// still builds. Run inside the fixture dir.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

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

  let httpOk = false;
  try {
    httpOk = /\bgetUserAgent\b/.test(readFileSync(join(fixtureDir, 'src/http.ts'), 'utf8'));
  } catch {
    httpOk = false;
  }
  if (!httpOk) notes.push('getUserAgent missing from src/http.ts (must not be renamed)');

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
