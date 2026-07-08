import type { DiffFile, SessionDiff } from './session-diff.types';

/** Per-file hunk cap: a file with more diff lines than this is collapsed 'too-large'. */
export const MAX_FILE_DIFF_LINES = 2000;
/** Hard total cap: files past this many bytes of diff text are omitted (phone-friendly). */
export const MAX_TOTAL_DIFF_BYTES = 1_000_000;

/** Lockfiles collapsed by default — they blow the phone view and are rarely hand-reviewed. */
export const LOCKFILE_NAMES: readonly string[] = [
  'package-lock.json',
  'bun.lock',
  'bun.lockb',
  'yarn.lock',
  'pnpm-lock.yaml',
  'Cargo.lock',
  'composer.lock',
  'Gemfile.lock',
  'poetry.lock',
];

/**
 * Parse git's raw unified diff output into a structured per-file shape (rung 3
 * sub-phase D). Pure, table-testable. Splits on `diff --git`, classifies status
 * (added/removed/renamed/binary/modified), and parses each `@@` hunk into typed
 * add/del/context lines. Binary files → status 'binary', hunks []. An empty diff
 * → { files: [] }.
 *
 * RED until implemented — neutral TODO so the parse tests don't false-green.
 */
export function parseUnifiedDiff(raw: string): DiffFile[] {
  throw new Error('TODO: parseUnifiedDiff not implemented');
  void raw;
}

/**
 * Apply the phone-safe caps to parsed files (rung 3 sub-phase D): collapse
 * lockfiles + binary + oversized files (hunks withheld, honest `collapsed`
 * marker), and drop files past the hard total-bytes cap into `omittedFiles`.
 * Every omission is LABELLED — never a silent drop.
 *
 * RED until implemented.
 */
export function capDiff(files: DiffFile[]): SessionDiff {
  throw new Error('TODO: capDiff not implemented');
  void files;
}
