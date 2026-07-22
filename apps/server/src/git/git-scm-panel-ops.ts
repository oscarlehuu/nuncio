import { BadRequestException } from '@nestjs/common';
import type {
  GitBlameDto,
  GitBlameLineDto,
  GitBranchSyncDto,
  GitCommitDto,
  GitDiffDto,
  GitHistoryCommitDto,
  GitHistoryDto,
  GitStashEntryDto,
  PullResultDto,
} from './git.types';

export const MAX_BRANCH_SYNC_COMMITS = 100;
export const MAX_BLAME_LINES = 400;
export const DEFAULT_HISTORY_LIMIT = 20;
export const MAX_HISTORY_LIMIT = 50;

const COMMIT_LOG_FORMAT = '--format=%H%x00%h%x00%s%x00%an%x00%aI%x1e';
const HISTORY_LOG_FORMAT = '--format=%H%x00%h%x00%s%x00%an%x00%aI%x00%P%x1e';

const CONFLICT_CODES = new Set(['UU', 'AA', 'DD', 'AU', 'UA', 'DU', 'UD']);

export type GitRunner = (args: string[], cwd: string) => Promise<string>;

export function parseCommitLog(output: string): GitCommitDto[] {
  if (!output.trim()) return [];
  const commits: GitCommitDto[] = [];
  for (const record of output.split('\x1e')) {
    const trimmed = record.replace(/^\n+/, '').trimEnd();
    if (!trimmed) continue;
    const [sha, shortSha, subject, authorName, authoredAt] = trimmed.split('\x00');
    if (!sha || !shortSha) continue;
    commits.push({
      sha,
      shortSha,
      subject: subject ?? '',
      authorName: authorName ?? '',
      authoredAt: authoredAt ?? '',
    });
  }
  return commits;
}

function parseHistoryLog(output: string): GitHistoryCommitDto[] {
  if (!output.trim()) return [];
  const commits: GitHistoryCommitDto[] = [];
  for (const record of output.split('\x1e')) {
    const trimmed = record.replace(/^\n+/, '').trimEnd();
    if (!trimmed) continue;
    const [sha, shortSha, subject, authorName, authoredAt, parentsRaw] = trimmed.split('\x00');
    if (!sha || !shortSha) continue;
    const parents = (parentsRaw ?? '')
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map((parent) => parent.slice(0, 7));
    commits.push({
      sha,
      shortSha,
      subject: subject ?? '',
      authorName: authorName ?? '',
      authoredAt: authoredAt ?? '',
      parents,
    });
  }
  return commits;
}

export function parseConflictPaths(porcelain: string): string[] {
  const conflicts: string[] = [];
  for (const line of porcelain.split('\n')) {
    if (!line || line.startsWith('## ')) continue;
    const index = line[0] ?? ' ';
    const workTree = line[1] ?? ' ';
    const code = `${index}${workTree}`;
    if (!CONFLICT_CODES.has(code)) continue;
    const path = line.slice(3).trim();
    if (path) conflicts.push(path);
  }
  return conflicts;
}

function truncateDiff(diff: string, maxDiffChars = 200_000): GitDiffDto {
  if (diff.length <= maxDiffChars) {
    return { diff, truncated: false };
  }
  return { diff: diff.slice(0, maxDiffChars), truncated: true };
}

async function logRange(
  git: GitRunner,
  repoRoot: string,
  range: string,
): Promise<GitCommitDto[]> {
  const output = await git(
    ['log', `--max-count=${MAX_BRANCH_SYNC_COMMITS}`, COMMIT_LOG_FORMAT, range],
    repoRoot,
  ).catch(() => '');
  return parseCommitLog(output);
}

export async function branchSync(
  git: GitRunner,
  repoRoot: string,
  branch: string,
  base: string | null,
): Promise<GitBranchSyncDto> {
  const porcelain = await git(['status', '--porcelain=v1'], repoRoot).catch(() => '');
  const conflicts = parseConflictPaths(porcelain);
  const clean = porcelain.trim().length === 0;

  let outgoing: GitCommitDto[] = [];
  let incoming: GitCommitDto[] = [];

  if (base) {
    outgoing = await logRange(git, repoRoot, `${base}..HEAD`);
    incoming = await logRange(git, repoRoot, `HEAD..${base}`);
  }

  return {
    branch,
    base,
    ahead: outgoing.length,
    behind: incoming.length,
    outgoing,
    incoming,
    conflicts,
    clean,
  };
}

export async function commitDiff(
  git: GitRunner,
  repoRoot: string,
  sha: string,
): Promise<GitDiffDto> {
  try {
    await git(['rev-parse', '--verify', sha], repoRoot);
  } catch {
    throw new BadRequestException('Invalid revision');
  }
  const diff = await git(['show', '--format=', '--patch', sha], repoRoot);
  return truncateDiff(diff);
}

export async function stashList(git: GitRunner, repoRoot: string): Promise<GitStashEntryDto[]> {
  const output = await git(
    ['stash', 'list', '--format=%gd%x00%s'],
    repoRoot,
  ).catch(() => '');

  if (!output.trim()) return [];

  const entries: GitStashEntryDto[] = [];
  for (const line of output.split('\n')) {
    if (!line.trim()) continue;
    const [ref, message] = line.split('\x00');
    if (!ref) continue;
    const indexMatch = ref.match(/stash@\{(\d+)\}/);
    const index = indexMatch ? Number(indexMatch[1]) : entries.length;
    let sha = '';
    try {
      sha = await git(['rev-parse', ref], repoRoot);
    } catch {
      sha = '';
    }
    entries.push({
      index,
      message: message ?? '',
      sha,
    });
  }
  return entries;
}

function parseBlamePorcelain(output: string, maxLines: number): { lines: GitBlameLineDto[]; truncated: boolean } {
  const lines: GitBlameLineDto[] = [];
  let truncated = false;
  let currentSha = '';
  let currentShortSha = '';
  let currentAuthor = '';
  let currentAuthoredAt = '';
  let currentLine = 0;

  for (const rawLine of output.split('\n')) {
    if (lines.length >= maxLines) {
      truncated = true;
      break;
    }

    if (rawLine.startsWith('\t')) {
      if (!currentSha) continue;
      lines.push({
        line: currentLine,
        sha: currentSha,
        shortSha: currentShortSha,
        authorName: currentAuthor,
        authoredAt: currentAuthoredAt,
        content: rawLine.slice(1),
      });
      continue;
    }

    const headerMatch = rawLine.match(/^([0-9a-f]{40})\s+(\d+)\s+(\d+)/);
    if (headerMatch) {
      currentSha = headerMatch[1] ?? '';
      currentShortSha = currentSha.slice(0, 7);
      currentLine = Number(headerMatch[3]);
      continue;
    }

    if (rawLine.startsWith('author ')) {
      currentAuthor = rawLine.slice('author '.length);
      continue;
    }

    if (rawLine.startsWith('author-time ')) {
      const epoch = Number(rawLine.slice('author-time '.length));
      currentAuthoredAt = Number.isFinite(epoch)
        ? new Date(epoch * 1000).toISOString()
        : '';
    }
  }

  return { lines, truncated };
}

export async function blame(
  git: GitRunner,
  repoRoot: string,
  filePath: string,
  validatePath: (path: string) => string,
): Promise<GitBlameDto> {
  const path = validatePath(filePath);
  try {
    const output = await git(['blame', '--line-porcelain', '--', path], repoRoot);
    const parsed = parseBlamePorcelain(output, MAX_BLAME_LINES);
    return { path, lines: parsed.lines, truncated: parsed.truncated };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new BadRequestException(`Failed to blame file: ${message}`);
  }
}

export async function history(
  git: GitRunner,
  repoRoot: string,
  branch: string,
  limit = DEFAULT_HISTORY_LIMIT,
  rev = 'HEAD',
): Promise<GitHistoryDto> {
  const capped = Math.min(Math.max(limit, 1), MAX_HISTORY_LIMIT);
  const output = await git(
    ['log', `--max-count=${capped}`, HISTORY_LOG_FORMAT, rev],
    repoRoot,
  ).catch(() => '');
  return {
    branch,
    commits: parseHistoryLog(output),
  };
}

export async function pull(git: GitRunner, repoRoot: string): Promise<PullResultDto> {
  try {
    const output = await git(['pull', '--ff-only'], repoRoot);
    const fastForward = /fast-forward/i.test(output);
    return { pulled: true, fastForward };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new BadRequestException(`Failed to pull: ${message}`);
  }
}
