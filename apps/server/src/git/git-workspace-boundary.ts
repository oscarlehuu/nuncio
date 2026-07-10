import { BadRequestException } from '@nestjs/common';
import { existsSync, lstatSync, realpathSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import type {
  GitBoundaryExpectation,
  GitBoundaryInspectionDto,
  GitCheckpointResultDto,
} from './git.types';
import {
  scanSensitiveCheckpointContents,
  sensitiveCheckpointPaths,
} from './git-sensitive-checkpoint-paths';

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

export async function checkpointGitWorkspace(
  requestedPath: string,
  message: string,
  operations: GitBoundaryOperations,
): Promise<GitCheckpointResultDto> {
  const trimmed = message.trim();
  if (!trimmed) throw new BadRequestException('Commit message is required');
  const before = await inspectGitWorkspaceBoundary(requestedPath, {}, operations);
  if (!before.ok || !before.fullHead) {
    throw new BadRequestException(`Invalid workspace boundary: ${before.reason ?? 'unknown'}`);
  }
  if (before.clean) return { fullHead: before.fullHead, clean: true, committed: false };

  const outputs = await Promise.all([
    operations.git(['diff', '--name-only', '-z', '--'], before.canonicalPath),
    operations.git(['diff', '--cached', '--name-only', '-z', '--'], before.canonicalPath),
    operations.git(['ls-files', '--others', '--exclude-standard', '-z'], before.canonicalPath),
  ]);
  const sensitive = sensitiveCheckpointPaths(outputs);
  if (sensitive.length > 0) {
    throw new BadRequestException(`Sensitive paths require explicit user handling: ${sensitive.join(', ')}`);
  }
  const contentScan = scanSensitiveCheckpointContents(before.canonicalPath, outputs);
  const unscanned = [...contentScan.overflowPaths, ...contentScan.unreadablePaths].sort();
  if (unscanned.length > 0) {
    throw new BadRequestException(
      `Checkpoint content scan could not safely inspect candidate paths: ${unscanned.join(', ')}`,
    );
  }
  if (contentScan.secretPaths.length > 0) {
    throw new BadRequestException(
      `Potential secret content requires explicit user handling: ${contentScan.secretPaths.join(', ')}`,
    );
  }

  const [name, email] = await Promise.all([
    operations.git(['config', '--local', '--get', 'user.name'], before.canonicalPath).catch(() => ''),
    operations.git(['config', '--local', '--get', 'user.email'], before.canonicalPath).catch(() => ''),
  ]);
  if (!name.trim() || !email.trim()) {
    throw new BadRequestException('Repository-local Git identity is required for checkpoint commits');
  }
  try {
    await operations.git(['add', '-A', '--', '.'], before.canonicalPath);
    await operations.git([
      '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false',
      'commit', '--no-verify', '-m', trimmed,
    ], before.canonicalPath);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new BadRequestException(`Failed to checkpoint workspace: ${reason}`);
  }
  const after = await inspectGitWorkspaceBoundary(before.canonicalPath, {}, operations);
  if (!after.ok || !after.fullHead || !after.clean) {
    throw new BadRequestException(`Checkpoint did not leave a clean workspace: ${after.reason ?? 'dirty'}`);
  }
  return { fullHead: after.fullHead, clean: true, committed: true };
}

/** Git SHA-1 and SHA-256 repositories expose 40- and 64-character full ids. */
export function isFullGitObjectId(value: string): boolean {
  return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value);
}
