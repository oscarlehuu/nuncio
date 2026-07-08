/**
 * Diff review (rung 3, sub-phase D). v1 = WORKTREE diffs only: a session's working
 * directory vs its base. The structured shape mirrors the forge `ForgeFileDiff` so
 * the web's existing diff renderers slot in; the server folds git's raw unified
 * output into it, caps it for the phone, and turns a hunk comment into a steer.
 */

export type DiffFileStatus = 'added' | 'modified' | 'removed' | 'renamed' | 'binary';

/** Why a file's hunks are withheld (present in the list, not inlined). */
export type DiffCollapseReason = 'binary' | 'lockfile' | 'too-large';

export type DiffLineKind = 'add' | 'del' | 'context';

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
}

export interface DiffHunk {
  /** The raw `@@ -a,b +c,d @@` header line. */
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

export interface DiffFile {
  path: string;
  /** Source path on a rename, else null. */
  oldPath: string | null;
  status: DiffFileStatus;
  additions: number;
  deletions: number;
  /** [] for binary / collapsed / omitted files. */
  hunks: DiffHunk[];
  /** Set when hunks are withheld — an honest marker, never a silent drop. */
  collapsed?: DiffCollapseReason;
}

/** The structured session diff returned by GET /sessions/:id/diff. */
export interface SessionDiff {
  files: DiffFile[];
  /** True when the hard total cap dropped files (see omittedFiles). */
  truncated: boolean;
  /** How many files were dropped past the hard total cap. */
  omittedFiles: number;
}

/** Body of POST /sessions/:id/diff/comment — a hunk comment that becomes a steer. */
export interface DiffCommentInput {
  path: string;
  startLine: number;
  endLine: number;
  /** The hunk text the founder is commenting on (capped in the steer message). */
  hunk: string;
  comment: string;
}
