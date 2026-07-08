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

export function parseUnifiedDiff(raw: string): DiffFile[] {
  const normalized = raw.replace(/\r\n/g, '\n').trim();
  if (!normalized) return [];

  const blocks = normalized
    .split(/(?=^diff --git )/m)
    .map((block) => block.trim())
    .filter(Boolean);

  return blocks.map(parseFileBlock);
}

export function capDiff(files: DiffFile[]): SessionDiff {
  if (files.length === 0) return { files: [], truncated: false, omittedFiles: 0 };

  const capped: DiffFile[] = [];
  let bytes = 0;
  let omittedFiles = 0;

  for (const file of files) {
    const next = collapseFile(file);
    const size = next.collapsed ? 0 : diffTextSize(next);
    if (bytes + size > MAX_TOTAL_DIFF_BYTES) {
      omittedFiles += 1;
      continue;
    }
    bytes += size;
    capped.push(next);
  }

  return { files: capped, truncated: omittedFiles > 0, omittedFiles };
}

function parseFileBlock(block: string): DiffFile {
  const lines = block.split('\n');
  const header = lines[0] ?? '';
  const headerMatch = header.match(/^diff --git a\/(.+) b\/(.+)$/);
  let oldPath = headerMatch?.[1] ?? null;
  let path = headerMatch?.[2] ?? oldPath ?? '';

  const renameFrom = findValue(lines, 'rename from ');
  const renameTo = findValue(lines, 'rename to ');
  const from = findPath(lines, '--- ');
  const to = findPath(lines, '+++ ');

  if (renameFrom && renameTo) {
    oldPath = renameFrom;
    path = renameTo;
  } else {
    if (to && to !== '/dev/null') path = stripDiffPath(to);
    if (from && from !== '/dev/null') oldPath = stripDiffPath(from);
  }

  const binary = lines.some((line) => line.startsWith('Binary files ') || line.startsWith('GIT binary patch'));
  const added = lines.some((line) => line === 'new file mode 100644') || from === '/dev/null';
  const removed = lines.some((line) => line === 'deleted file mode 100644') || to === '/dev/null';
  const renamed = Boolean(renameFrom && renameTo);
  const status = binary ? 'binary' : added ? 'added' : removed ? 'removed' : renamed ? 'renamed' : 'modified';

  let additions = 0;
  let deletions = 0;
  const hunks: DiffFile['hunks'] = [];
  let current: DiffFile['hunks'][number] | null = null;

  for (const line of lines) {
    if (line.startsWith('@@ ')) {
      current = parseHunkHeader(line);
      hunks.push(current);
      continue;
    }
    if (!current) continue;
    if (line.startsWith('+') && !line.startsWith('+++')) {
      current.lines.push({ kind: 'add', text: line.slice(1) });
      additions += 1;
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      current.lines.push({ kind: 'del', text: line.slice(1) });
      deletions += 1;
    } else if (line.startsWith(' ')) {
      current.lines.push({ kind: 'context', text: line.slice(1) });
    }
  }

  return { path, oldPath: renamed ? oldPath : null, status, additions, deletions, hunks: binary ? [] : hunks };
}

function parseHunkHeader(header: string): DiffFile['hunks'][number] {
  const match = header.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
  return {
    header,
    oldStart: Number(match?.[1] ?? 0),
    oldLines: Number(match?.[2] ?? 1),
    newStart: Number(match?.[3] ?? 0),
    newLines: Number(match?.[4] ?? 1),
    lines: [],
  };
}

function findValue(lines: string[], prefix: string): string | null {
  return lines.find((line) => line.startsWith(prefix))?.slice(prefix.length).trim() ?? null;
}

function findPath(lines: string[], prefix: string): string | null {
  return lines.find((line) => line.startsWith(prefix))?.slice(prefix.length).trim() ?? null;
}

function stripDiffPath(path: string): string {
  return path.startsWith('a/') || path.startsWith('b/') ? path.slice(2) : path;
}

function collapseFile(file: DiffFile): DiffFile {
  if (file.status === 'binary') return { ...file, hunks: [], collapsed: 'binary' };
  if (isLockfile(file.path)) return { ...file, hunks: [], collapsed: 'lockfile' };
  if (file.hunks.reduce((sum, hunk) => sum + hunk.lines.length, 0) > MAX_FILE_DIFF_LINES) {
    return { ...file, hunks: [], collapsed: 'too-large' };
  }
  return { ...file, hunks: file.hunks.map((hunk) => ({ ...hunk, lines: [...hunk.lines] })) };
}

function isLockfile(path: string): boolean {
  const name = path.split('/').pop() ?? path;
  return LOCKFILE_NAMES.includes(name) || name.endsWith('.lock');
}

function diffTextSize(file: DiffFile): number {
  let size = file.path.length + 64;
  for (const hunk of file.hunks) {
    size += hunk.header.length + 1;
    for (const line of hunk.lines) {
      size += line.text.length + 2;
    }
  }
  return size;
}
