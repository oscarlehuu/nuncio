// Fixture determinism: building the proof fixture twice, in two independent tmp
// dirs, must yield an identical `git rev-parse HEAD`. This is the invariant that
// makes eval runs comparable across machines and time — any non-determinism
// (wall-clock in a commit, machine gitconfig, default branch name, forced GPG
// signing, hooks) breaks it. Lives under scripts/ so `bun run test:scripts` runs
// it from the repo root with the right cwd; the fixture owns nothing cwd-dependent.
import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setup } from '../eval/fixtures/echo-readme/setup.mjs';

function headSha(dir) {
  const res = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' });
  if (res.status !== 0) throw new Error(`git rev-parse failed: ${res.stderr}`);
  return res.stdout.trim();
}

describe('echo-readme fixture', () => {
  const savedGlobal = process.env.GIT_CONFIG_GLOBAL;
  afterEach(() => {
    if (savedGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = savedGlobal;
  });

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

  test('HEAD is unchanged under a hostile global git config (gpgsign + hooks)', async () => {
    // Baseline SHA with a clean global config.
    delete process.env.GIT_CONFIG_GLOBAL;
    const clean = await mkdtemp(join(tmpdir(), 'eval-fixture-clean-'));

    // A hostile/opinionated global config that WOULD break or alter a naive
    // commit: forced GPG signing, a hooks dir, a foreign identity, and CRLF.
    const cfgDir = await mkdtemp(join(tmpdir(), 'eval-hostile-gitcfg-'));
    const cfgFile = join(cfgDir, 'gitconfig');
    await writeFile(
      cfgFile,
      [
        '[user]',
        '\tname = Someone Else',
        '\temail = someone@evil.example',
        '[commit]',
        '\tgpgsign = true',
        '[tag]',
        '\tgpgsign = true',
        '[core]',
        `\thooksPath = ${join(cfgDir, 'hooks')}`,
        '\tautocrlf = true',
        '',
      ].join('\n'),
      'utf8',
    );
    const hostile = await mkdtemp(join(tmpdir(), 'eval-fixture-hostile-'));

    try {
      await setup(clean);
      const baseline = headSha(clean);

      process.env.GIT_CONFIG_GLOBAL = cfgFile;
      await setup(hostile);
      expect(headSha(hostile)).toBe(baseline);
    } finally {
      await rm(clean, { recursive: true, force: true });
      await rm(hostile, { recursive: true, force: true });
      await rm(cfgDir, { recursive: true, force: true });
    }
  });
});
