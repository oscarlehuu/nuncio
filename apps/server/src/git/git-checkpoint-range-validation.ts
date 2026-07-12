import { BadRequestException } from '@nestjs/common';
import type { GitBoundaryOperations } from './git-workspace-boundary';
import { inspectGitWorkspaceBoundary, isFullGitObjectId } from './git-workspace-boundary';
import {
  type GitBlobReader,
  validateChangedGitBlobs,
} from './git-checkpoint-blob-validation';
import {
  containsHighConfidenceSecret,
  MAX_CHECKPOINT_CANDIDATE_BYTES,
} from './git-sensitive-checkpoint-paths';

export interface GitCheckpointRangeOperations extends GitBoundaryOperations {
  readBlobs: GitBlobReader;
}

/** Validate the exact clean tree delta that a settled Builder wants accepted. */
export async function validateGitCheckpointRange(
  requestedPath: string,
  fromHead: string,
  toHead: string,
  operations: GitCheckpointRangeOperations,
): Promise<void> {
  if (!isFullGitObjectId(fromHead) || !isFullGitObjectId(toHead)) {
    throw new BadRequestException('Checkpoint range requires full Git object ids');
  }
  const boundary = await inspectGitWorkspaceBoundary(
    requestedPath,
    { expectedAncestorHead: fromHead, expectedCanonicalPath: requestedPath },
    operations,
  );
  if (!boundary.ok || !boundary.clean || boundary.fullHead !== toHead) {
    throw new BadRequestException(
      `Checkpoint range boundary is invalid: ${boundary.reason ?? 'dirty or changed head'}`,
    );
  }
  if (fromHead === toHead) return;
  await assertSingleLinearCommit(boundary.canonicalPath, fromHead, toHead, operations);
  await validateCommitMessage(boundary.canonicalPath, toHead, operations);

  const raw = await operations.git([
    'diff-tree', '--no-commit-id', '--raw', '-r', '-z', '--no-renames', fromHead, toHead, '--',
  ], boundary.canonicalPath);
  await validateChangedGitBlobs(boundary.canonicalPath, raw, operations.readBlobs);
}

async function assertSingleLinearCommit(
  cwd: string,
  fromHead: string,
  toHead: string,
  operations: GitBoundaryOperations,
): Promise<void> {
  const raw = await operations.git([
    'rev-list', '--parents', '--topo-order', '--reverse', `${fromHead}..${toHead}`, '--',
  ], cwd);
  const lines = raw.split('\n').filter((line) => line.length > 0);
  const row = lines.length === 1 ? lines[0]!.split(' ') : [];
  if (row.length !== 2 || row[0] !== toHead || row[1] !== fromHead
    || !row.every(isFullGitObjectId)) {
    throw new BadRequestException(
      'Checkpoint range must contain a single linear commit; squash Builder history before acceptance',
    );
  }
}

async function validateCommitMessage(
  cwd: string,
  toHead: string,
  operations: GitBoundaryOperations,
): Promise<void> {
  const sizeText = await operations.git(['cat-file', '-s', toHead], cwd);
  const size = Number(sizeText);
  if (!Number.isSafeInteger(size) || size < 0 || size > MAX_CHECKPOINT_CANDIDATE_BYTES) {
    throw unscannable(['(commit message)']);
  }
  const commit = await operations.git(['cat-file', 'commit', toHead], cwd);
  const messageStart = commit.indexOf('\n\n');
  if (messageStart < 0) throw unscannable(['(commit message)']);
  if (containsHighConfidenceSecret(commit.slice(messageStart + 2))) {
    throw new BadRequestException(
      'Potential secret content requires explicit user handling: (commit message)',
    );
  }
}

function unscannable(paths: string[]): BadRequestException {
  return new BadRequestException(
    `Checkpoint content scan could not safely inspect candidate paths: ${[...new Set(paths)].sort().join(', ')}`,
  );
}
