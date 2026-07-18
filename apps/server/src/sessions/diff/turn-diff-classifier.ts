import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Shared turn-diff classifier (provider-neutral). One module answers, per
 * settled turn: did this turn change the workspace, and what kind of change is
 * it? The verify loop consumes the fingerprint to skip no-op verifies; the
 * Engine gate-integrity hook and evidence pairing consume the classes.
 */

export type TurnDiffClass = 'ui' | 'gate-protected' | 'other';

export interface WorkspaceDiffSnapshot {
  /** HEAD sha, or `(no-head)` for a repo without commits. */
  head: string;
  /** Changed paths relative to the repo root, capped at {@link DIFF_SNAPSHOT_MAX_FILES}. */
  files: string[];
  /** Total changed paths before the cap. */
  filesTotal: number;
  /** Distinct classes across ALL changed files (not just the capped list), sorted. */
  classes: TurnDiffClass[];
  /**
   * Stable digest of HEAD + every dirty path + its size/mtime. Two equal
   * fingerprints mean "no observable workspace change between the captures".
   */
  fingerprint: string;
}

/** Keeps the verify_start payload well under the event-payload byte ceiling. */
const DIFF_SNAPSHOT_MAX_FILES = 20;

/**
 * Extensions that render UI — classification is file-type based, not repo-layout
 * based, because sessions run in arbitrary user projects.
 */
const UI_EXTENSIONS = new Set([
  'tsx', 'jsx', 'css', 'scss', 'sass', 'less', 'vue', 'svelte', 'html', 'htm',
]);

/** The harness-owned gate directory: `.nuncio/**` at any depth. */
const GATE_DIR = '.nuncio';

export function classifyPath(relPath: string): TurnDiffClass {
  const segments = relPath.split('/');
  if (segments.includes(GATE_DIR)) return 'gate-protected';
  const name = segments[segments.length - 1] ?? '';
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
  return UI_EXTENSIONS.has(ext) ? 'ui' : 'other';
}

/** Distinct classes across a file list, sorted for stable payloads. */
export function classifyFiles(paths: string[]): TurnDiffClass[] {
  return [...new Set(paths.map(classifyPath))].sort();
}

async function git(args: string[], cwd: string): Promise<string | null> {
  try {
    const proc = Bun.spawn(['git', ...args], {
      cwd,
      stdout: 'pipe',
      stderr: 'pipe',
      stdin: 'ignore',
    });
    const output = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    return exitCode === 0 ? output : null;
  } catch {
    return null;
  }
}

/**
 * Parse `git status --porcelain -uall -z` output into repo-relative paths.
 * `-z` entries are NUL-separated; a rename/copy entry is followed by one extra
 * NUL-separated field (the original path), which is skipped.
 */
function parsePorcelainZ(output: string): string[] {
  const fields = output.split('\0').filter((field) => field.length > 0);
  const paths: string[] = [];
  let skipNext = false;
  for (const field of fields) {
    if (skipNext) {
      skipNext = false;
      continue;
    }
    // "XY path" — two status chars + one space.
    const status = field.slice(0, 2);
    const path = field.slice(3);
    if (!path) continue;
    paths.push(path);
    if (status.startsWith('R') || status.startsWith('C')) skipNext = true;
  }
  return paths;
}

/**
 * Capture the workspace's diff state: HEAD plus every dirty path with its
 * size/mtime, folded into one fingerprint. Returns null when `cwd` is not a git
 * work tree (caller must then behave as if the workspace always changed).
 * All failures are soft — a broken git never breaks the verify loop.
 */
export async function captureWorkspaceDiffSnapshot(
  cwd: string,
): Promise<WorkspaceDiffSnapshot | null> {
  const toplevel = (await git(['rev-parse', '--show-toplevel'], cwd))?.trim();
  if (!toplevel) return null;
  const head = (await git(['rev-parse', 'HEAD'], cwd))?.trim() || '(no-head)';
  const status = await git(['status', '--porcelain', '-uall', '-z'], cwd);
  if (status === null) return null;

  const files = parsePorcelainZ(status).sort();
  const hash = createHash('sha256').update(head);
  for (const file of files) {
    let size = -1;
    let mtimeMs = 0;
    try {
      const stats = await stat(join(toplevel, file));
      size = stats.size;
      mtimeMs = stats.mtimeMs;
    } catch {
      // Deleted or unreadable — the (-1, 0) marker still distinguishes it.
    }
    hash.update(`\0${file}\0${size}\0${mtimeMs}`);
  }

  return {
    head,
    files: files.slice(0, DIFF_SNAPSHOT_MAX_FILES),
    filesTotal: files.length,
    classes: classifyFiles(files),
    fingerprint: hash.digest('hex'),
  };
}
