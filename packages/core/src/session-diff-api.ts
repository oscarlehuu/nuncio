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
