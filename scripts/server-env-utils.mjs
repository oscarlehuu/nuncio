import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, join, isAbsolute } from 'node:path';
import { spawnSync } from 'node:child_process';

export function parseGitWorktrees(output) {
  const entries = [];
  let current = {};

  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) {
      if (current.path) entries.push(current);
      current = {};
      continue;
    }

    const separator = line.indexOf(' ');
    const key = separator === -1 ? line : line.slice(0, separator);
    const value = separator === -1 ? true : line.slice(separator + 1);

    if (key === 'worktree') current.path = value;
    if (key === 'branch') current.branch = value;
  }

  if (current.path) entries.push(current);
  return entries;
}

export function resolveEnvPath(value, baseDir, homeDir = homedir()) {
  if (value.startsWith('~/')) return join(homeDir, value.slice(2));
  if (value === '~') return homeDir;
  return isAbsolute(value) ? value : resolve(baseDir, value);
}

export function findMainWorktreeEnv(repoRoot, worktreeOutput, exists = existsSync) {
  const worktrees = parseGitWorktrees(worktreeOutput);

  for (const worktree of worktrees) {
    if (worktree.branch !== 'refs/heads/main') continue;

    const envPath = join(worktree.path, '.env');
    if (exists(envPath)) return envPath;
  }

  const primaryWorktree = worktrees[0];
  if (primaryWorktree) {
    const envPath = join(primaryWorktree.path, '.env');
    if (exists(envPath)) return envPath;
  }

  const fallback = join(repoRoot, '.env');
  return exists(fallback) ? fallback : null;
}

export function resolveServerEnvFile(options = {}) {
  const repoRoot = options.repoRoot ?? process.cwd();
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? homedir();
  const exists = options.exists ?? existsSync;
  const runGit = options.runGit ?? defaultRunGit;

  const explicit = env.NUNCIO_ENV_FILE?.trim();
  if (explicit) {
    const explicitPath = resolveEnvPath(explicit, repoRoot, homeDir);
    if (!exists(explicitPath)) {
      throw new Error(`NUNCIO_ENV_FILE points to a missing file: ${explicitPath}`);
    }
    return explicitPath;
  }

  const worktreeOutput = runGit(repoRoot);
  const mainEnv = findMainWorktreeEnv(repoRoot, worktreeOutput, exists);
  if (mainEnv) return mainEnv;

  const sharedEnv = join(homeDir, '.nuncio', '.env');
  return exists(sharedEnv) ? sharedEnv : null;
}

function defaultRunGit(repoRoot) {
  const result = spawnSync('git', ['worktree', 'list', '--porcelain'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });

  return result.status === 0 ? result.stdout : '';
}
