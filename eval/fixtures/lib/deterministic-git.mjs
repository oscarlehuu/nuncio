// Shared deterministic-git helper for eval fixture builders. Every fixture uses
// this so its `git rev-parse HEAD` is byte-stable across machines and runs —
// the invariant that makes eval results comparable. All the machine-git-config
// escape hatches that could shift or break a commit are neutralized per command:
//
//   - fixed identity + fixed author/committer dates → no wall-clock, no ~/.gitconfig identity
//   - commit.gpgsign=false                          → a global signing config can't alter/break the commit
//   - core.hooksPath= (empty) + --no-verify         → a global hooks dir can't mutate the tree/commit
//   - init --object-format=sha1                      → object format is pinned (never sha256)
//   - init -b main                                   → branch name never varies (main vs master)
//   - core.autocrlf=false                            → line-ending rewrites can't shift blob hashes
//
// Fixture file contents must still use \n and carry no timestamps; this helper
// covers the git layer only.
import { spawnSync } from 'node:child_process';

export const FIXTURE_AUTHOR_NAME = 'Eval Fixture';
export const FIXTURE_AUTHOR_EMAIL = 'eval@nuncio.local';
// A fixed instant well in the past; identical for author and committer so the
// commit object is fully determined by tree + message + identity.
export const FIXTURE_FIXED_DATE = '2020-01-01T00:00:00+0000';

// Config flags forced onto EVERY git invocation so no machine-global setting
// (identity, signing, hooks, line endings) can perturb the resulting SHA.
const HARDENING_FLAGS = [
  '-c',
  `user.name=${FIXTURE_AUTHOR_NAME}`,
  '-c',
  `user.email=${FIXTURE_AUTHOR_EMAIL}`,
  '-c',
  'commit.gpgsign=false',
  '-c',
  'tag.gpgsign=false',
  '-c',
  'core.hooksPath=',
  '-c',
  'core.autocrlf=false',
];

/**
 * Returns a `git(...args)` runner bound to `dir` with the hardening flags and a
 * fixed date environment applied to every call. Throws on non-zero exit.
 */
export function deterministicGit(dir) {
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: FIXTURE_AUTHOR_NAME,
    GIT_AUTHOR_EMAIL: FIXTURE_AUTHOR_EMAIL,
    GIT_COMMITTER_NAME: FIXTURE_AUTHOR_NAME,
    GIT_COMMITTER_EMAIL: FIXTURE_AUTHOR_EMAIL,
    GIT_AUTHOR_DATE: FIXTURE_FIXED_DATE,
    GIT_COMMITTER_DATE: FIXTURE_FIXED_DATE,
  };
  return (...args) => {
    const res = spawnSync('git', [...HARDENING_FLAGS, ...args], {
      cwd: dir,
      env,
      stdio: 'pipe',
      encoding: 'utf8',
    });
    if (res.status !== 0) {
      throw new Error(`git ${args.join(' ')} failed: ${res.stderr || res.stdout}`);
    }
    return res.stdout;
  };
}

/** Initialize a hardened repo in `dir` (fixed branch + pinned object format). */
export function initRepo(dir) {
  const git = deterministicGit(dir);
  git('init', '-b', 'main', '--object-format=sha1');
  // Persist identity into .git/config too. Commit objects already use -c / env
  // (so HEAD stays byte-stable), but Crew checkpoint commits require a
  // repository-local user.name/user.email or they block as unrecoverable.
  git('config', 'user.name', FIXTURE_AUTHOR_NAME);
  git('config', 'user.email', FIXTURE_AUTHOR_EMAIL);
  return git;
}

/**
 * Write a map of { 'repo/relative/path': 'contents' } into `dir`, creating
 * parent directories. Contents must use \n and carry no timestamps so blob
 * hashes stay fixed.
 */
export async function writeFiles(dir, files) {
  const { mkdir, writeFile } = await import('node:fs/promises');
  const { dirname, join } = await import('node:path');
  for (const [rel, contents] of Object.entries(files)) {
    const abs = join(dir, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, contents, 'utf8');
  }
}

/** Stage everything and make the single seed commit with a fixed message. */
export function commitAll(git, message = 'Seed fixture') {
  git('add', '-A');
  git('commit', '--no-verify', '-m', message);
}

/**
 * Standard fixture build: init a hardened repo in `dir`, write `files`, and make
 * one seed commit. Returns the bound git runner for any extra steps.
 */
export async function buildFixture(dir, files, message = 'Seed fixture') {
  const git = initRepo(dir);
  await writeFiles(dir, files);
  commitAll(git, message);
  return git;
}

/**
 * Build a two-branch fixture deterministically. `main` holds `base.files`; then a
 * `branch.name` branch is cut and `branch.files` (a full overlay — same map
 * shape, values replace/add) are committed on it. Both commits use the shared
 * fixed date/identity/hardening, so `git rev-parse main` AND `git rev-parse
 * <branch>` are byte-stable across machines. The working tree is left on `main`.
 *
 * @param {string} dir
 * @param {{ files: Record<string,string>, message?: string }} base
 * @param {{ name: string, files: Record<string,string>, message?: string }} branch
 */
export async function buildBranchedFixture(dir, base, branch) {
  const git = initRepo(dir);
  await writeFiles(dir, base.files);
  commitAll(git, base.message ?? 'Seed fixture (main)');

  git('checkout', '-b', branch.name);
  await writeFiles(dir, branch.files);
  commitAll(git, branch.message ?? `Seed fixture (${branch.name})`);

  // Leave the caller on main — the diff is main..branch.
  git('checkout', 'main');
  return git;
}
