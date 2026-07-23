import { basename, dirname, resolve } from 'node:path';

/**
 * A project's identity, derived from the git repository rather than the raw
 * working directory. All worktrees of one repo (main checkout + any linked
 * worktrees) resolve to the same {@link RepoIdentity.id}, so sessions and tasks
 * spread across them group under a single project. A non-git folder falls back
 * to path identity so loose directories never regress.
 */
export interface RepoIdentity {
  /** `repo` when derived from a git repository; `path` for a non-git folder. */
  kind: 'repo' | 'path';
  /** Stable grouping key: remote URL when present, else the repo root, else the path. */
  id: string;
  /** The owning repository's main working tree, or the folder itself for non-git. */
  repoRoot: string;
  /** Normalized remote URL (`host/owner/repo`) when an origin remote exists, else null. */
  remoteUrl: string | null;
}

export interface RepoIdentityInput {
  /** The working directory that was queried. */
  path: string;
  /** `git rev-parse --show-toplevel` for the working dir, or null when not a git repo. */
  toplevel: string | null;
  /** Absolute `git rev-parse --git-common-dir` — the shared `.git` of the owning repo. */
  commonDir?: string | null;
  /** `git remote get-url origin`, or null when there is no origin remote. */
  remoteUrl?: string | null;
}

function normalizePath(path: string): string {
  return resolve(path.trim());
}

/**
 * Reduce a git remote URL to a host/owner/repo identity so that the same repo
 * referenced over https or ssh (with or without a trailing `.git`) collapses to
 * one key. Returns null for empty or unparseable input.
 */
export function normalizeRemoteUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const trimmed = url.trim();
  if (!trimmed) return null;

  let host: string;
  let path: string;
  const sshMatch = trimmed.match(/^[a-zA-Z0-9._-]+@([^:/]+):(.+)$/);
  if (sshMatch) {
    host = sshMatch[1];
    path = sshMatch[2];
  } else {
    try {
      const parsed = new URL(trimmed);
      host = parsed.host;
      path = parsed.pathname;
    } catch {
      return null;
    }
  }

  host = host.toLowerCase().replace(/^www\./, '');
  const cleanedPath = path
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '')
    .toLowerCase();
  if (!host || !cleanedPath) return null;
  return `${host}/${cleanedPath}`;
}

function deriveRepoRoot(toplevel: string, commonDir?: string | null): string {
  if (commonDir) {
    const normalizedCommon = normalizePath(commonDir);
    // A linked worktree's common dir points at the OWNING repo's `.git`; its
    // parent is that repo's main working tree — the identity anchor shared by
    // every worktree of the repo.
    if (basename(normalizedCommon) === '.git') {
      return dirname(normalizedCommon);
    }
  }
  return normalizePath(toplevel);
}

/**
 * Compute the {@link RepoIdentity} for a working directory. Pure — all git
 * lookups happen in the caller so this stays trivially testable.
 */
export function computeRepoIdentity(input: RepoIdentityInput): RepoIdentity {
  if (!input.toplevel) {
    const normalizedPath = normalizePath(input.path);
    return { kind: 'path', id: normalizedPath, repoRoot: normalizedPath, remoteUrl: null };
  }

  const repoRoot = deriveRepoRoot(input.toplevel, input.commonDir);
  const remoteUrl = normalizeRemoteUrl(input.remoteUrl);
  const id = remoteUrl ? `remote:${remoteUrl}` : `repo:${repoRoot}`;
  return { kind: 'repo', id, repoRoot, remoteUrl };
}
