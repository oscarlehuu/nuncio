import { apiFetch } from './http';

export type DiffFileStatus = 'added' | 'modified' | 'removed' | 'renamed' | 'binary';
export type DiffCollapseReason = 'binary' | 'lockfile' | 'too-large';
export type DiffLineKind = 'add' | 'del' | 'context';

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
}

export interface DiffHunk {
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

export interface DiffFile {
  path: string;
  oldPath: string | null;
  status: DiffFileStatus;
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
  collapsed?: DiffCollapseReason;
}

export interface SessionDiff {
  files: DiffFile[];
  truncated: boolean;
  omittedFiles: number;
}

export interface DiffCommentInput {
  path: string;
  startLine: number;
  endLine: number;
  hunk: string;
  comment: string;
}

/**
 * The debug-mode instrumentation sentinel. Every log line a debug agent adds
 * carries this exact token so cleanup is a mechanical sweep. Must stay in sync
 * with the server overlay's `DEBUG_SENTINEL`.
 */
export const DEBUG_SENTINEL = '// nuncio-debug';

export interface DebugSentinelReport {
  /** Total number of ADDED lines that still carry the sentinel. */
  count: number;
  /** Distinct files those lines live in. */
  files: string[];
}

/**
 * Scan a session diff for leftover debug instrumentation (D3). Counts only
 * ADDED lines carrying {@link DEBUG_SENTINEL}: a removed line (`del`) is the
 * cleanup itself and an unchanged context line was not added by this session, so
 * neither is a leak. A clean sweep yields `{ count: 0, files: [] }`.
 */
export function countDebugSentinelLines(diff: SessionDiff | null | undefined): DebugSentinelReport {
  const files = new Set<string>();
  let count = 0;
  for (const file of diff?.files ?? []) {
    for (const hunk of file.hunks) {
      for (const line of hunk.lines) {
        if (line.kind === 'add' && line.text.includes(DEBUG_SENTINEL)) {
          count += 1;
          files.add(file.path);
        }
      }
    }
  }
  return { count, files: [...files] };
}

export async function fetchSessionDiff(sessionId: string): Promise<SessionDiff> {
  const res = await apiFetch(`/api/sessions/${sessionId}/diff`);
  if (!res.ok) throw new Error('Failed to load session diff');
  return res.json();
}

export async function postDiffComment(
  sessionId: string,
  input: DiffCommentInput,
): Promise<unknown> {
  const res = await apiFetch(`/api/sessions/${sessionId}/diff/comment`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error('Failed to send diff comment');
  return res.json();
}
