import {
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
} from 'node:fs';
import { basename, isAbsolute, relative, resolve } from 'node:path';

export const MAX_CHECKPOINT_CANDIDATE_BYTES = 1_048_576;
export const MAX_CHECKPOINT_TOTAL_BYTES = 8_388_608;
export const MAX_CHECKPOINT_CANDIDATE_FILES = 2_048;

const HIGH_CONFIDENCE_TOKEN_PATTERNS = [
  /sk-proj-[A-Za-z0-9_-]{32,}/g,
  /sk-ant-[A-Za-z0-9_-]{32,}/g,
  /\bsk-[A-Za-z0-9]{32,}\b/g,
  /\bghp_[A-Za-z0-9]{36}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{40,}\b/g,
  /\bglpat-[A-Za-z0-9_-]{20,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g,
] as const;

const HIGH_CONFIDENCE_PRIVATE_KEY_PATTERN =
  /-----BEGIN [^-\n]*PRIVATE KEY-----[\s\S]{80,}-----END [^-\n]*PRIVATE KEY-----/g;
const REDACTED_SECRET = '[REDACTED]';

function hasDocumentedSampleMarker(path: string): boolean {
  return /(^|[._-])(example|sample|template|fixture)([._-]|$)/i.test(basename(path).trim());
}

function isSensitiveCheckpointPath(path: string): boolean {
  if (hasDocumentedSampleMarker(path)) return false;
  const name = basename(path).trim().toLowerCase();
  if (name === '.env' || name.startsWith('.env.')) return true;
  if (['.envrc', '.npmrc', '.git-credentials'].includes(name)) return true;
  if (/\.(pem|key|p12|pfx|jks|keystore)$/i.test(name)) return true;
  if (name === 'id_rsa' || name === 'id_ed25519' || name === '.netrc' || name === '.pypirc') {
    return true;
  }

  const configExtension = /(?:^|\.)(json|ya?ml|toml|ini|conf|config|txt|env)$/i.test(name)
    || !name.includes('.');
  if (!configExtension) return false;
  const stem = name.replace(/\.(json|ya?ml|toml|ini|conf|config|txt|env)$/i, '');
  return /(^|[._-])(auth|credentials?|tokens?|secrets?|api-key|private-key)([._-]|$)/i.test(stem);
}

function splitNullTerminatedPaths(output: string): string[] {
  // `-z` output is already unambiguous. Preserve each path byte-for-byte:
  // trimming would make us inspect a different file and could let a whitespace-
  // prefixed secret bypass the scan before `git add -A` stages the real path.
  return output.split('\0').filter((path) => path.length > 0);
}

function changedCheckpointPaths(outputs: string[]): string[] {
  const changedPaths = new Set<string>();
  for (const output of outputs) {
    for (const path of splitNullTerminatedPaths(output)) changedPaths.add(path);
  }
  return [...changedPaths].sort();
}

export function sensitiveCheckpointPaths(outputs: string[]): string[] {
  return changedCheckpointPaths(outputs).filter(isSensitiveCheckpointPath);
}

export interface SensitiveCheckpointContentScan {
  secretPaths: string[];
  overflowPaths: string[];
  unreadablePaths: string[];
}

export function scanSensitiveCheckpointContents(
  repoRoot: string,
  outputs: string[],
): SensitiveCheckpointContentScan {
  const paths = changedCheckpointPaths(outputs);
  const result: SensitiveCheckpointContentScan = {
    secretPaths: [],
    overflowPaths: [],
    unreadablePaths: [],
  };
  if (paths.length > MAX_CHECKPOINT_CANDIDATE_FILES) {
    result.overflowPaths.push('(too many changed files)');
    return result;
  }

  let totalBytes = 0;
  for (const path of paths) {
    const absolute = resolve(repoRoot, path);
    const fromRoot = relative(repoRoot, absolute);
    if (!fromRoot || fromRoot.startsWith('..') || isAbsolute(fromRoot)) {
      result.unreadablePaths.push(path);
      continue;
    }
    try {
      const stat = lstatSync(absolute);
      if (stat.isDirectory()) continue;
      if (stat.isSymbolicLink()) {
        result.unreadablePaths.push(path);
        continue;
      }
      if (!stat.isFile()) {
        result.unreadablePaths.push(path);
        continue;
      }
      if (
        stat.size > MAX_CHECKPOINT_CANDIDATE_BYTES
        || totalBytes + stat.size > MAX_CHECKPOINT_TOTAL_BYTES
      ) {
        result.overflowPaths.push(path);
        continue;
      }
      const content = readBoundedFile(absolute, stat.size);
      totalBytes += content.length;
      if (containsHighConfidenceSecret(content.toString('utf8'))) result.secretPaths.push(path);
    } catch (error) {
      if (isMissingFile(error)) continue; // Deleted paths add no content to the checkpoint.
      if (error instanceof ScanOverflowError) result.overflowPaths.push(path);
      else result.unreadablePaths.push(path);
    }
  }
  return result;
}

class ScanOverflowError extends Error {}

function readBoundedFile(path: string, expectedBytes: number): Buffer {
  const fd = openSync(path, 'r');
  try {
    const currentSize = fstatSync(fd).size;
    if (currentSize > MAX_CHECKPOINT_CANDIDATE_BYTES) throw new ScanOverflowError();
    const capacity = Math.max(expectedBytes, currentSize);
    const content = Buffer.alloc(capacity);
    let offset = 0;
    while (offset < content.length) {
      const count = readSync(fd, content, offset, content.length - offset, null);
      if (count === 0) break;
      offset += count;
    }
    const extra = Buffer.alloc(1);
    if (readSync(fd, extra, 0, 1, null) > 0) throw new ScanOverflowError();
    return content.subarray(0, offset);
  } finally {
    closeSync(fd);
  }
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT';
}

export function containsHighConfidenceSecret(content: string): boolean {
  for (const pattern of HIGH_CONFIDENCE_TOKEN_PATTERNS) {
    for (const match of content.matchAll(pattern)) {
      if (!isPlaceholder(match[0])) return true;
    }
  }
  return content.match(HIGH_CONFIDENCE_PRIVATE_KEY_PATTERN) !== null;
}

/**
 * Remove the exact secret families that make checkpoint validation fail while
 * retaining surrounding diagnostic text. Wholly synthetic token placeholders
 * remain readable under the same exception used by detection.
 */
export function redactHighConfidenceSecrets(content: string): string {
  let redacted = content;
  for (const pattern of HIGH_CONFIDENCE_TOKEN_PATTERNS) {
    redacted = redacted.replace(pattern, (value) =>
      isPlaceholder(value) ? value : REDACTED_SECRET,
    );
  }
  return redacted.replace(HIGH_CONFIDENCE_PRIVATE_KEY_PATTERN, REDACTED_SECRET);
}

function isPlaceholder(value: string): boolean {
  const body = value.replace(
    /^(?:sk-(?:proj-|ant-)?|ghp_|github_pat_|glpat-|AKIA|AIza|xox[baprs]-)/i,
    '',
  );
  const compact = body.toLowerCase().replace(/[-_]/g, '');
  // Exempt only an entirely synthetic body. A marker word embedded in otherwise
  // credential-like material is still a possible real secret and must block.
  return /^(?:(?:example|sample|placeholder|dummy|redacted|changeme|your(?:apikey|token|secret|key)?here))+$/.test(
    compact,
  );
}
