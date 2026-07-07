// Fixture determinism: building the proof fixture twice, in two independent tmp
// dirs, must yield an identical `git rev-parse HEAD`. This is the invariant that
// makes eval runs comparable across machines and time — any non-determinism
// (wall-clock in a commit, machine gitconfig, default branch name) breaks it.
// Lives under scripts/ so `bun run test:scripts` runs it from the repo root with
// the right cwd; the fixture itself owns nothing cwd-dependent.
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setup } from '../eval/fixtures/echo-readme/setup.mjs';

function headSha(dir) {
  const res = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' });
  if (res.status !== 0) throw new Error(`git rev-parse failed: ${res.stderr}`);
  return res.stdout.trim();
}

describe('echo-readme fixture', () => {
  test('two independent builds produce an identical HEAD sha', async () => {
    const dirA = await mkdtemp(join(tmpdir(), 'eval-fixture-a-'));
    const dirB = await mkdtemp(join(tmpdir(), 'eval-fixture-b-'));
    try {
      await setup(dirA);
      await setup(dirB);
      expect(headSha(dirA)).toBe(headSha(dirB));
    } finally {
      await rm(dirA, { recursive: true, force: true });
      await rm(dirB, { recursive: true, force: true });
    }
  });
});
