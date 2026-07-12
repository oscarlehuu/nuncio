import { BadRequestException } from '@nestjs/common';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type GitBlobReader,
  validateChangedGitBlobs,
} from './git-checkpoint-blob-validation';
import {
  containsHighConfidenceSecret,
  MAX_CHECKPOINT_CANDIDATE_BYTES,
  scanSensitiveCheckpointContents,
  sensitiveCheckpointPaths,
} from './git-sensitive-checkpoint-paths';
import type { GitCheckpointResultDto } from './git.types';
import {
  type GitBoundaryOperations,
  inspectGitWorkspaceBoundary,
  isFullGitObjectId,
} from './git-workspace-boundary';

export interface GitCheckpointOperations extends GitBoundaryOperations {
  gitWithIndex(args: string[], cwd: string, indexPath: string): Promise<string>;
  readBlobs: GitBlobReader;
}

export async function checkpointGitWorkspace(
  requestedPath: string,
  message: string,
  operations: GitCheckpointOperations,
): Promise<GitCheckpointResultDto> {
  const trimmed = message.trim();
  validateMessage(trimmed);
  const before = await inspectGitWorkspaceBoundary(requestedPath, {}, operations);
  if (!before.ok || !before.fullHead || !before.branch) {
    throw new BadRequestException(`Invalid workspace boundary: ${before.reason ?? 'unknown'}`);
  }
  if (before.clean) return { fullHead: before.fullHead, clean: true, committed: false };

  await validateMutableCandidates(before.canonicalPath, operations);
  await requireLocalIdentity(before.canonicalPath, operations);
  const indexDir = mkdtempSync(join(tmpdir(), 'nuncio-checkpoint-index-'));
  const indexPath = join(indexDir, 'index');
  let commitHead: string;
  try {
    await operations.gitWithIndex(['read-tree', before.fullHead], before.canonicalPath, indexPath);
    await operations.gitWithIndex(['add', '-A', '--', '.'], before.canonicalPath, indexPath);
    const raw = await operations.gitWithIndex([
      'diff-index', '--cached', '--raw', '-r', '-z', '--no-renames', before.fullHead, '--',
    ], before.canonicalPath, indexPath);
    await validateChangedGitBlobs(before.canonicalPath, raw, operations.readBlobs);
    const tree = await operations.gitWithIndex(['write-tree'], before.canonicalPath, indexPath);
    if (!isFullGitObjectId(tree)) throw new Error('checkpoint tree did not return a full object id');
    commitHead = await operations.git([
      '--no-replace-objects', '-c', 'commit.gpgSign=false',
      'commit-tree', tree, '-p', before.fullHead, '-m', trimmed,
    ], before.canonicalPath);
    if (!isFullGitObjectId(commitHead)) throw new Error('checkpoint commit did not return a full object id');
    await operations.git([
      '-c', 'core.hooksPath=/dev/null',
      'update-ref', `refs/heads/${before.branch}`, commitHead, before.fullHead,
    ], before.canonicalPath);
    await operations.git(['read-tree', '--reset', commitHead], before.canonicalPath);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new BadRequestException(`Failed to checkpoint workspace: ${reason}`);
  } finally {
    rmSync(indexDir, { recursive: true, force: true });
  }
  const after = await inspectGitWorkspaceBoundary(before.canonicalPath, {}, operations);
  if (!after.ok || after.fullHead !== commitHead || !after.clean) {
    throw new BadRequestException(`Checkpoint did not leave a clean workspace: ${after.reason ?? 'dirty'}`);
  }
  return { fullHead: after.fullHead, clean: true, committed: true };
}

function validateMessage(message: string): void {
  if (!message) throw new BadRequestException('Commit message is required');
  if (Buffer.byteLength(message, 'utf8') > MAX_CHECKPOINT_CANDIDATE_BYTES) {
    throw new BadRequestException(
      'Checkpoint content scan could not safely inspect candidate paths: (commit message)',
    );
  }
  if (containsHighConfidenceSecret(message)) {
    throw new BadRequestException(
      'Potential secret content requires explicit user handling: (commit message)',
    );
  }
}

async function validateMutableCandidates(
  cwd: string, operations: GitBoundaryOperations,
): Promise<void> {
  const outputs = await Promise.all([
    operations.git(['diff', '--name-only', '-z', '--'], cwd),
    operations.git(['diff', '--cached', '--name-only', '-z', '--'], cwd),
    operations.git(['ls-files', '--others', '--exclude-standard', '-z'], cwd),
  ]);
  const sensitive = sensitiveCheckpointPaths(outputs);
  if (sensitive.length > 0) {
    throw new BadRequestException(`Sensitive paths require explicit user handling: ${sensitive.join(', ')}`);
  }
  const scan = scanSensitiveCheckpointContents(cwd, outputs);
  const unscanned = [...scan.overflowPaths, ...scan.unreadablePaths].sort();
  if (unscanned.length > 0) {
    throw new BadRequestException(
      `Checkpoint content scan could not safely inspect candidate paths: ${unscanned.join(', ')}`,
    );
  }
  if (scan.secretPaths.length > 0) {
    throw new BadRequestException(
      `Potential secret content requires explicit user handling: ${scan.secretPaths.join(', ')}`,
    );
  }
}

async function requireLocalIdentity(cwd: string, operations: GitBoundaryOperations): Promise<void> {
  const [name, email] = await Promise.all([
    operations.git(['config', '--local', '--get', 'user.name'], cwd).catch(() => ''),
    operations.git(['config', '--local', '--get', 'user.email'], cwd).catch(() => ''),
  ]);
  if (!name.trim() || !email.trim()) {
    throw new BadRequestException('Repository-local Git identity is required for checkpoint commits');
  }
}
