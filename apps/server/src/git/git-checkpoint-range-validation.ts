import { BadRequestException } from '@nestjs/common';
import type { GitBoundaryOperations } from './git-workspace-boundary';
import { inspectGitWorkspaceBoundary, isFullGitObjectId } from './git-workspace-boundary';
import {
  containsHighConfidenceSecret,
  MAX_CHECKPOINT_CANDIDATE_BYTES,
  MAX_CHECKPOINT_CANDIDATE_FILES,
  MAX_CHECKPOINT_TOTAL_BYTES,
  sensitiveCheckpointPaths,
} from './git-sensitive-checkpoint-paths';

interface ChangedBlob { path: string; objectId: string; mode: string }

const FULL_OBJECT_ID_SOURCE = '(?:[0-9a-f]{40}|[0-9a-f]{64})';
const BLOB_METADATA_PATTERN = new RegExp(`^(${FULL_OBJECT_ID_SOURCE}) blob ([0-9]+)$`);
const RAW_CHANGE_PATTERN = new RegExp(
  `^:(\\d{6}) (\\d{6}) (${FULL_OBJECT_ID_SOURCE}) (${FULL_OBJECT_ID_SOURCE}) ([A-Z])$`,
);

export interface GitCheckpointRangeOperations extends GitBoundaryOperations {
  readBlobs(cwd: string, candidates: ChangedBlob[]): Promise<Map<string, Buffer>>;
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
  const candidates = parseChangedBlobs(raw).filter((entry) => entry.mode !== '000000');
  if (candidates.length > MAX_CHECKPOINT_CANDIDATE_FILES) {
    throw unscannable(['(too many changed files)']);
  }
  if (candidates.length === 0) return; // A deletion-only tree delta has no final content to scan.

  const sensitive = sensitiveCheckpointPaths([
    candidates.map((entry) => `${entry.path}\0`).join(''),
  ]);
  if (sensitive.length > 0) {
    throw new BadRequestException(
      `Sensitive paths require explicit user handling: ${sensitive.join(', ')}`,
    );
  }
  const nonRegular = candidates
    .filter((entry) => entry.mode !== '100644' && entry.mode !== '100755')
    .map((entry) => entry.path);
  if (nonRegular.length > 0) throw unscannable(nonRegular);

  const blobs = await operations.readBlobs(boundary.canonicalPath, candidates);
  const secretPaths = candidates.filter((entry) => {
    const content = blobs.get(entry.objectId);
    if (!content) throw unscannable([entry.path]);
    return containsHighConfidenceSecret(content.toString('utf8'));
  }).map((entry) => entry.path);
  if (secretPaths.length > 0) {
    throw new BadRequestException(
      `Potential secret content requires explicit user handling: ${secretPaths.join(', ')}`,
    );
  }
}

/** Read committed blobs only after their declared sizes pass all scan bounds. */
export async function readBoundedGitBlobs(
  cwd: string,
  candidates: ChangedBlob[],
): Promise<Map<string, Buffer>> {
  const objectIds = [...new Set(candidates.map((entry) => entry.objectId))];
  const paths = candidates.map((entry) => entry.path);
  try {
    const checked = (await runGitBatch(
      cwd,
      ['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'],
      objectIds,
    )).toString('utf8').trimEnd().split('\n');
    if (checked.length !== objectIds.length) throw new Error('incomplete Git object metadata');
    const sizes = new Map<string, number>();
    checked.forEach((line, index) => {
      const match = BLOB_METADATA_PATTERN.exec(line);
      if (!match || match[1] !== objectIds[index]) throw new Error('invalid Git object metadata');
      sizes.set(match[1], Number(match[2]));
    });

    let total = 0;
    const overflow: string[] = [];
    for (const entry of candidates) {
      const size = sizes.get(entry.objectId);
      if (!Number.isSafeInteger(size) || size! > MAX_CHECKPOINT_CANDIDATE_BYTES
        || total + size! > MAX_CHECKPOINT_TOTAL_BYTES) overflow.push(entry.path);
      else total += size!;
    }
    if (overflow.length > 0) throw unscannable(overflow);

    const output = await runGitBatch(cwd, ['cat-file', '--batch'], objectIds);
    return parseBatchBlobs(output, objectIds, sizes);
  } catch (error) {
    if (error instanceof BadRequestException) throw error;
    throw unscannable(paths);
  }
}

function parseChangedBlobs(raw: string): ChangedBlob[] {
  const chunks = raw.split('\0');
  if (chunks.at(-1) === '') chunks.pop();
  const entries: ChangedBlob[] = [];
  for (let index = 0; index < chunks.length; index += 2) {
    const header = chunks[index];
    const path = chunks[index + 1];
    const match = header ? RAW_CHANGE_PATTERN.exec(header) : null;
    if (!match || path === undefined || path.length === 0 || !isFullGitObjectId(match[4]!)) {
      throw new BadRequestException('Checkpoint range diff could not be parsed safely');
    }
    entries.push({ path, mode: match[2]!, objectId: match[4]! });
  }
  return entries;
}

async function runGitBatch(cwd: string, args: string[], objectIds: string[]): Promise<Buffer> {
  const proc = Bun.spawn(
    ['git', '--no-replace-objects', ...args],
    { cwd, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
  );
  const stdout = new Response(proc.stdout).arrayBuffer();
  const stderr = new Response(proc.stderr).text();
  proc.stdin.write(`${objectIds.join('\n')}\n`);
  proc.stdin.end();
  const [code, bytes, errorText] = await Promise.all([proc.exited, stdout, stderr]);
  if (code !== 0) throw new Error(errorText.trim() || `git ${args[0]} failed`);
  return Buffer.from(bytes);
}

function parseBatchBlobs(
  output: Buffer,
  objectIds: string[],
  sizes: Map<string, number>,
): Map<string, Buffer> {
  const blobs = new Map<string, Buffer>();
  let offset = 0;
  for (const objectId of objectIds) {
    const newline = output.indexOf(0x0a, offset);
    const header = newline >= 0 ? output.subarray(offset, newline).toString('utf8') : '';
    const size = sizes.get(objectId);
    if (header !== `${objectId} blob ${size}` || size === undefined) throw new Error('invalid Git blob');
    const start = newline + 1;
    const end = start + size;
    if (newline < 0 || end >= output.length || output[end] !== 0x0a) throw new Error('truncated Git blob');
    blobs.set(objectId, output.subarray(start, end));
    offset = end + 1;
  }
  if (offset !== output.length) throw new Error('unexpected Git blob output');
  return blobs;
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
