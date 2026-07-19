import { truncateHeadBytes } from './byte-truncate';
import {
  buildWorkspaceSnapshot,
  runSnapshotGit,
  type WorkspaceSnapshot,
} from './workspace-snapshot';

/**
 * Session-start workspace context: the plain `WorkspaceSnapshot` (branch, HEAD,
 * dirty files) extended with recent commit subjects and the tracked top-level
 * entries — the facts an agent otherwise re-derives with its first few tool
 * calls (`git status`, `git log`, `ls`) on every fresh session. Deliberately
 * NOT a repo map: one level deep, hard caps, deterministic.
 *
 * The rendered block is persisted only inside `sessions.prompt` like the other
 * preamble sections; this struct itself is not part of the durable
 * handoff-brief contract — extending `WorkspaceSnapshot` would touch persisted
 * task rows.
 */
export interface SessionWorkspaceContext {
  snapshot: WorkspaceSnapshot;
  /** `<shortSha> <subject>` lines, newest first, capped at 3. */
  recentCommits: string[];
  /** Tracked top-level entries; directories carry a trailing `/`. Capped at 30 with an `…and N more` line. */
  topLevelEntries: string[];
}

const RECENT_COMMIT_CAP = 3;
const COMMIT_LINE_MAX_BYTES = 160;
const TOP_LEVEL_CAP = 30;
const ENTRY_MAX_BYTES = 120;
/** Hard cap on the rendered block so a pathological repo can never blow the preamble budget. */
export const WORKSPACE_CONTEXT_MAX_BYTES = 1536;

function capLines(lines: string[], cap: number, maxBytes: number): string[] {
  const nonEmpty = lines.filter((line) => line.length > 0);
  const kept = nonEmpty.slice(0, cap).map((line) => truncateHeadBytes(line, maxBytes));
  const overflow = nonEmpty.length - kept.length;
  return overflow > 0 ? [...kept, `…and ${overflow} more`] : kept;
}

/**
 * Build the session-start workspace context for a git cwd. Returns null for a
 * non-git directory; individual subcommand failures degrade to empty sections
 * (same best-effort semantics as `buildWorkspaceSnapshot`).
 */
export async function buildSessionWorkspaceContext(
  cwd: string,
  baseBranch?: string | null,
): Promise<SessionWorkspaceContext | null> {
  const snapshot = await buildWorkspaceSnapshot(cwd, baseBranch);
  if (!snapshot) return null;

  const log = await runSnapshotGit(cwd, [
    'log',
    `-${RECENT_COMMIT_CAP}`,
    '--pretty=format:%h %s',
  ]);
  const recentCommits = log
    ? capLines(log.split('\n'), RECENT_COMMIT_CAP, COMMIT_LINE_MAX_BYTES)
    : [];

  // `ls-tree HEAD` lists tracked top-level entries as `<mode> <type> <sha>\t<name>`;
  // type `tree` marks a directory. Tracked-only keeps noise (node_modules,
  // build output) out without hand-maintaining an ignore list.
  const lsTree = await runSnapshotGit(cwd, ['ls-tree', 'HEAD']);
  const entries = lsTree
    ? lsTree
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => {
          const tab = line.indexOf('\t');
          if (tab < 0) return null;
          const name = line.slice(tab + 1);
          const isDir = line.slice(0, tab).split(' ')[1] === 'tree';
          return truncateHeadBytes(isDir ? `${name}/` : name, ENTRY_MAX_BYTES);
        })
        .filter((entry): entry is string => Boolean(entry))
    : [];
  const topLevelEntries =
    entries.length > TOP_LEVEL_CAP
      ? [...entries.slice(0, TOP_LEVEL_CAP), `…and ${entries.length - TOP_LEVEL_CAP} more`]
      : entries;

  return { snapshot, recentCommits, topLevelEntries };
}

/**
 * Render the compact `## Workspace` preamble block. Output is hard-capped at
 * `WORKSPACE_CONTEXT_MAX_BYTES` (UTF-8-safe truncation).
 */
export function renderWorkspaceContext(context: SessionWorkspaceContext): string {
  const { snapshot } = context;
  const lines: string[] = ['## Workspace'];

  const head: string[] = [];
  // `rev-parse --abbrev-ref HEAD` reports the literal `HEAD` on a detached
  // checkout — say so instead of presenting it as a branch name.
  if (snapshot.branch === 'HEAD') {
    head.push(
      snapshot.baseBranch
        ? `branch: (detached) (base: ${snapshot.baseBranch})`
        : 'branch: (detached)',
    );
  } else if (snapshot.branch) {
    head.push(
      snapshot.baseBranch && snapshot.baseBranch !== snapshot.branch
        ? `branch: ${snapshot.branch} (base: ${snapshot.baseBranch})`
        : `branch: ${snapshot.branch}`,
    );
  }
  if (snapshot.headSha) head.push(`head: ${snapshot.headSha}`);
  if (head.length > 0) lines.push(head.join('  '));

  lines.push(
    snapshot.dirtyFiles.length === 0
      ? 'status: clean'
      : `status: dirty — ${snapshot.dirtyFiles.join(', ')}`,
  );

  if (context.recentCommits.length > 0) {
    lines.push(`recent commits: ${context.recentCommits.join(' | ')}`);
  }
  if (context.topLevelEntries.length > 0) {
    lines.push(`top-level: ${context.topLevelEntries.join(', ')}`);
  }

  return truncateHeadBytes(lines.join('\n'), WORKSPACE_CONTEXT_MAX_BYTES);
}
