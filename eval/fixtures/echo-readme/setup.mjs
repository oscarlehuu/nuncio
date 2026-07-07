// Deterministic fixture builder for the mock proof task. Writes fixed-content
// files into the caller-provided tmp dir and commits them with a FIXED author
// and FIXED author/committer dates, so `git rev-parse HEAD` is byte-stable
// across machines and runs (proven by the fixture-determinism self-test).
//
// Determinism guards, all load-bearing:
//   - `git init -b main`            → branch name never varies (main vs master)
//   - `-c user.name/-c user.email`  → machine ~/.gitconfig cannot shift the SHA
//   - GIT_AUTHOR/COMMITTER_DATE env → no wall-clock in the commit object
//   - file contents use \n, no timestamps → blob hashes are fixed
import { spawnSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const AUTHOR_NAME = 'Eval Fixture';
const AUTHOR_EMAIL = 'eval@nuncio.local';
// A fixed instant well in the past; identical for author and committer so the
// commit object is fully determined by tree + message + identity.
const FIXED_DATE = '2020-01-01T00:00:00+0000';

const README = ['# Echo Fixture', '', 'A deterministic repo for the mock echo eval task.', ''].join(
  '\n',
);

/**
 * Build the fixture in `dir` (a fresh tmp dir the caller owns). Returns the dir.
 * @param {string} dir absolute path to an existing empty directory
 */
export async function setup(dir) {
  await writeFile(join(dir, 'README.md'), README, 'utf8');

  const git = (...args) => {
    const res = spawnSync('git', args, {
      cwd: dir,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: AUTHOR_NAME,
        GIT_AUTHOR_EMAIL: AUTHOR_EMAIL,
        GIT_COMMITTER_NAME: AUTHOR_NAME,
        GIT_COMMITTER_EMAIL: AUTHOR_EMAIL,
        GIT_AUTHOR_DATE: FIXED_DATE,
        GIT_COMMITTER_DATE: FIXED_DATE,
      },
      stdio: 'pipe',
      encoding: 'utf8',
    });
    if (res.status !== 0) {
      throw new Error(`git ${args.join(' ')} failed: ${res.stderr || res.stdout}`);
    }
    return res.stdout;
  };

  git('init', '-b', 'main');
  git('-c', `user.name=${AUTHOR_NAME}`, '-c', `user.email=${AUTHOR_EMAIL}`, 'add', '-A');
  git(
    '-c',
    `user.name=${AUTHOR_NAME}`,
    '-c',
    `user.email=${AUTHOR_EMAIL}`,
    'commit',
    '-m',
    'Seed echo fixture',
  );
  return dir;
}
