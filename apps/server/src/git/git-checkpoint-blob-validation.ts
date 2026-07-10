import { BadRequestException } from '@nestjs/common';
import {
  containsHighConfidenceSecret,
  MAX_CHECKPOINT_CANDIDATE_BYTES,
  MAX_CHECKPOINT_CANDIDATE_FILES,
  MAX_CHECKPOINT_TOTAL_BYTES,
  sensitiveCheckpointPaths,
} from './git-sensitive-checkpoint-paths';

export interface ChangedGitBlob { path: string; objectId: string; mode: string }
export type GitBlobReader = (
  cwd: string, candidates: ChangedGitBlob[],
) => Promise<Map<string, Buffer>>;

const FULL_OBJECT_ID_SOURCE = '(?:[0-9a-f]{40}|[0-9a-f]{64})';
const BLOB_METADATA_PATTERN = new RegExp(`^(${FULL_OBJECT_ID_SOURCE}) blob ([0-9]+)$`);
const RAW_CHANGE_PATTERN = new RegExp(
  `^:(\\d{6}) (\\d{6}) (${FULL_OBJECT_ID_SOURCE}) (${FULL_OBJECT_ID_SOURCE}) ([A-Z])$`,
);

/** Validate exact Git blobs, not mutable worktree bytes, before accepting a checkpoint. */
export async function validateChangedGitBlobs(
  cwd: string, raw: string, readBlobs: GitBlobReader,
): Promise<void> {
  const candidates = parseChangedBlobs(raw).filter((entry) => entry.mode !== '000000');
  if (candidates.length > MAX_CHECKPOINT_CANDIDATE_FILES) {
    throw unscannable(['(too many changed files)']);
  }
  if (candidates.length === 0) return;

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

  const blobs = await readBlobs(cwd, candidates);
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

/** Read committed or staged blobs only after their declared sizes pass all scan bounds. */
export async function readBoundedGitBlobs(
  cwd: string, candidates: ChangedGitBlob[],
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

function parseChangedBlobs(raw: string): ChangedGitBlob[] {
  const chunks = raw.split('\0');
  if (chunks.at(-1) === '') chunks.pop();
  const entries: ChangedGitBlob[] = [];
  for (let index = 0; index < chunks.length; index += 2) {
    const header = chunks[index];
    const path = chunks[index + 1];
    const match = header ? RAW_CHANGE_PATTERN.exec(header) : null;
    if (!match || path === undefined || path.length === 0) {
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
  output: Buffer, objectIds: string[], sizes: Map<string, number>,
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

function unscannable(paths: string[]): BadRequestException {
  return new BadRequestException(
    `Checkpoint content scan could not safely inspect candidate paths: ${[...new Set(paths)].sort().join(', ')}`,
  );
}
