import { existsSync, lstatSync, realpathSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import type {
  GitBoundaryExpectation,
  GitBoundaryInspectionDto,
} from './git.types';

export interface GitBoundaryOperations {
  git(args: string[], cwd: string): Promise<string>;
  isAncestor(ancestor: string, descendant: string, cwd: string): Promise<boolean>;
}

function pathWithoutTrustedOsAlias(path: string): string {
  if (process.platform !== 'darwin') return path;
  for (const [alias, canonical] of [
    ['/var', '/private/var'],
    ['/tmp', '/private/tmp'],
    ['/etc', '/private/etc'],
  ] as const) {
    if (path === alias || path.startsWith(`${alias}/`)) {
      return `${canonical}${path.slice(alias.length)}`;
    }
  }
  return path;
}

export async function inspectGitWorkspaceBoundary(
  requestedPath: string,
  expectation: string | GitBoundaryExpectation,
  operations: GitBoundaryOperations,
): Promise<GitBoundaryInspectionDto> {
  const expected = typeof expectation === 'string' ? { expectedBranch: expectation } : expectation;
  const requested = resolve(requestedPath);
  const result: GitBoundaryInspectionDto = {
    ok: false, exists: false, symlink: false, canonicalPath: requested,
    branch: null, fullHead: null, clean: false, reachable: false, reason: 'missing',
  };
  if (!requestedPath.trim() || !existsSync(requested)) return result;

  result.exists = true;
  try {
    result.symlink = lstatSync(requested).isSymbolicLink();
    if (result.symlink) {
      result.canonicalPath = realpathSync.native(requested);
      result.reason = 'symlink';
      return result;
    }
    if (!statSync(requested).isDirectory()) {
      result.reason = 'not-directory';
      return result;
    }
    result.canonicalPath = realpathSync.native(requested);
    if (pathWithoutTrustedOsAlias(requested) !== result.canonicalPath) {
      result.symlink = true;
      result.reason = 'symlink';
      return result;
    }
  } catch {
    result.reason = 'missing';
    return result;
  }

  let repoRoot: string;
  try {
    repoRoot = realpathSync.native(resolve(await operations.git(['rev-parse', '--show-toplevel'], result.canonicalPath)));
  } catch {
    result.reason = 'not-git';
    return result;
  }
  if (repoRoot !== result.canonicalPath) {
    result.reason = 'workspace-root-mismatch';
    return result;
  }
  if (expected.expectedCanonicalPath) {
    try {
      if (realpathSync.native(resolve(expected.expectedCanonicalPath)) !== result.canonicalPath) {
        result.reason = 'workspace-root-mismatch';
        return result;
      }
    } catch {
      result.reason = 'workspace-root-mismatch';
      return result;
    }
  }

  try {
    result.fullHead = await operations.git(['rev-parse', '--verify', 'HEAD'], repoRoot);
    if (!isFullGitObjectId(result.fullHead)) throw new Error('non-canonical HEAD');
    result.branch = await operations.git(['symbolic-ref', '--quiet', '--short', 'HEAD'], repoRoot) || null;
    result.clean = (await operations.git(['status', '--porcelain'], repoRoot)).length === 0;
  } catch {
    result.reason = result.fullHead ? 'detached-head' : 'not-git';
    return result;
  }

  result.reachable = true;
  if (expected.expectedBranch?.trim() && result.branch !== expected.expectedBranch.trim()) {
    result.reason = 'branch-mismatch';
    return result;
  }
  if (expected.expectedAncestorHead) {
    const ancestor = expected.expectedAncestorHead.trim();
    result.reachable = isFullGitObjectId(ancestor)
      ? await operations.isAncestor(ancestor, result.fullHead, repoRoot)
      : false;
    if (!result.reachable) {
      result.reason = 'head-diverged';
      return result;
    }
  }
  result.ok = true;
  result.reason = null;
  return result;
}

/** Git SHA-1 and SHA-256 repositories expose 40- and 64-character full ids. */
export function isFullGitObjectId(value: string): boolean {
  return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value);
}
