import { truncateHeadBytes } from './byte-truncate';

/** Cheap, precise git refs for a handoff — never file contents. */
export interface WorkspaceSnapshot {
  branch: string | null;
  /** Short SHA of HEAD. */
  headSha: string | null;
  baseBranch: string | null;
  /** Porcelain paths, capped at 20 with a trailing `…and N more` line. */
  dirtyFiles: string[];
  /** `git diff --stat <base>...HEAD`, capped at 1024 bytes. */
  diffStat: string | null;
}

const GIT_TIMEOUT_MS = 3000;
const DIRTY_FILE_CAP = 20;
const DIFF_STAT_MAX_BYTES = 1024;
/** Byte-cap the scalar ref fields so a pathological branch/sha can't blow a downstream payload budget. */
const REF_NAME_MAX_BYTES = 256;
const SHA_MAX_BYTES = 64;

function capRef(value: string | null, maxBytes: number): string | null {
  return value ? truncateHeadBytes(value, maxBytes) : value;
}

/**
 * Run a git subcommand with a hard timeout. Returns trimmed stdout on success,
 * or null on any failure (not a repo, non-zero exit, timeout, spawn error).
 * Never throws — a snapshot is best-effort context, never a blocker.
 * Exported for the session workspace-context builder, which extends the
 * snapshot with the same degrade-gracefully semantics.
 */
export async function runSnapshotGit(cwd: string, args: string[]): Promise<string | null> {
  try {
    const proc = Bun.spawn(['git', ...args], {
      cwd,
      stdout: 'pipe',
      stderr: 'ignore',
      stdin: 'ignore',
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, GIT_TIMEOUT_MS);
    try {
      const stdout = await new Response(proc.stdout).text().catch(() => '');
      const exitCode = await proc.exited;
      if (timedOut || exitCode !== 0) return null;
      return stdout;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return null;
  }
}

function capDirtyFiles(porcelain: string): string[] {
  const lines = porcelain
    .split('\n')
    .filter((line) => line.length > 0)
    // Porcelain format is `XY <path>`: 2 status chars then a space, then the
    // path (renames use `old -> new`; keep the new path).
    .map((line) => {
      const path = line.slice(3).trim();
      const arrow = path.indexOf(' -> ');
      return arrow >= 0 ? path.slice(arrow + 4).trim() : path;
    })
    .filter(Boolean);
  if (lines.length <= DIRTY_FILE_CAP) return lines;
  const overflow = lines.length - DIRTY_FILE_CAP;
  return [...lines.slice(0, DIRTY_FILE_CAP), `…and ${overflow} more`];
}

function capDiffStat(stat: string): string | null {
  const trimmed = stat.trimEnd();
  if (!trimmed) return null;
  // UTF-8-aware: never emit a diffStat ending in a split multi-byte character.
  return truncateHeadBytes(trimmed, DIFF_STAT_MAX_BYTES);
}

/**
 * Snapshot the git state of `cwd`. Taken only at delegation/finish moments, so
 * no caching. Returns null for a non-git directory; individual subcommand
 * failures degrade gracefully (e.g. a missing base branch → null diffStat)
 * without discarding the whole snapshot.
 */
export async function buildWorkspaceSnapshot(
  cwd: string,
  baseBranch?: string | null,
): Promise<WorkspaceSnapshot | null> {
  const branchRaw = await runSnapshotGit(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branchRaw === null) return null; // Not a git repo (or git unavailable).

  const branch = capRef(branchRaw.trim() || null, REF_NAME_MAX_BYTES);
  const headShaRaw = await runSnapshotGit(cwd, ['rev-parse', '--short', 'HEAD']);
  const headSha = capRef(headShaRaw?.trim() || null, SHA_MAX_BYTES);
  const porcelain = await runSnapshotGit(cwd, ['status', '--porcelain']);
  const dirtyFiles = porcelain ? capDirtyFiles(porcelain) : [];

  let diffStat: string | null = null;
  const base = capRef(baseBranch?.trim() || null, REF_NAME_MAX_BYTES);
  if (base) {
    const raw = await runSnapshotGit(cwd, ['diff', '--stat', `${base}...HEAD`]);
    diffStat = raw ? capDiffStat(raw) : null;
  }

  return { branch, headSha, baseBranch: base, dirtyFiles, diffStat };
}
