// Deterministic fixture builder for the mock proof task. Writes fixed-content
// files into the caller-provided tmp dir and commits them via the shared
// deterministic-git helper, so `git rev-parse HEAD` is byte-stable across
// machines and runs regardless of the machine's global git config (identity,
// signing, hooks, line endings). See ../lib/deterministic-git.mjs for the guards.
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { initRepo } from '../lib/deterministic-git.mjs';

const README = ['# Echo Fixture', '', 'A deterministic repo for the mock echo eval task.', ''].join(
  '\n',
);

/**
 * Build the fixture in `dir` (a fresh tmp dir the caller owns). Returns the dir.
 * @param {string} dir absolute path to an existing empty directory
 */
export async function setup(dir) {
  await writeFile(join(dir, 'README.md'), README, 'utf8');

  const git = initRepo(dir);
  git('add', '-A');
  git('commit', '--no-verify', '-m', 'Seed echo fixture');
  return dir;
}
