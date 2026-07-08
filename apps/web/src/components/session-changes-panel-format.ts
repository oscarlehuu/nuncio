import type { DiffFile, DiffHunk } from '../lib/api';

export type ComposerKey = `${string}:${number}`;

export function hunkText(hunk: DiffHunk): string {
  const lines = hunk.lines.map((line) => {
    if (line.kind === 'add') return `+${line.text}`;
    if (line.kind === 'del') return `-${line.text}`;
    return ` ${line.text}`;
  });
  return [hunk.header, ...lines].join('\n');
}

export function hunkRange(hunk: DiffHunk): { startLine: number; endLine: number } {
  const startLine = hunk.newLines > 0 ? hunk.newStart : hunk.oldStart;
  const lineCount = Math.max(hunk.newLines > 0 ? hunk.newLines : hunk.oldLines, 1);
  return { startLine, endLine: startLine + lineCount - 1 };
}

export function collapsedLabel(file: DiffFile): string {
  if (file.collapsed === 'binary' || file.status === 'binary') return 'Binary file';
  if (file.collapsed === 'lockfile') return 'Lockfile collapsed';
  if (file.collapsed === 'too-large') return 'Diff too large';
  return 'Diff unavailable';
}
