import { BadRequestException, Injectable } from '@nestjs/common';
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { SettingsService } from '../settings/settings.service';
import {
  readBoundedGitBlobs,
} from './git-checkpoint-blob-validation';
import { validateGitCheckpointRange } from './git-checkpoint-range-validation';
import { inspectGitWorkspaceBoundary } from './git-workspace-boundary';
import { checkpointGitWorkspace } from './git-workspace-checkpoint';
import {
  blame as blameFile,
  branchSync as computeBranchSync,
  commitDiff as showCommitDiff,
  history as loadHistory,
  pull as pullRemote,
  stashList as listStashes,
} from './git-scm-panel-ops';
import type {
  BranchDto,
  CommitResultDto,
  GitBoundaryExpectation,
  GitBoundaryInspectionDto,
  GitCheckpointResultDto,
  GitBlameDto,
  GitBranchSyncDto,
  GitDiffDto,
  GitFileChange,
  GitHistoryDto,
  GitStatusDto,
  GitStashEntryDto,
  GitUnpushedCommitsDto,
  ProjectDto,
  PullResultDto,
  PushResultDto,
  RemoteInfoDto,
  WorktreeResult,
} from './git.types';

function expandHome(path: string): string {
  return path.startsWith('~/') ? join(homedir(), path.slice(2)) : path;
}

function sanitizeSlug(slug: string): string {
  return slug
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, 30)
    .replace(/^-|-$/g, '') || 'task';
}

async function git(
  args: string[], cwd?: string, env?: Record<string, string | undefined>,
): Promise<string> {
  const proc = Bun.spawn(['git', ...args], {
    cwd,
    ...(env ? { env } : {}),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const code = await proc.exited;
  const rawStdout = await new Response(proc.stdout).text();
  // NUL-delimited path output is a binary-safe protocol. Trimming it mutates
  // legitimate leading/trailing whitespace in filenames before secret scans.
  const stdout = args.includes('-z') ? rawStdout : rawStdout.trim();
  const stderr = (await new Response(proc.stderr).text()).trim();
  if (code !== 0) {
    throw new Error(stderr || stdout || `git ${args.join(' ')} failed`);
  }
  return stdout;
}

async function gitWithIndex(args: string[], cwd: string, indexPath: string): Promise<string> {
  return git(args, cwd, { ...process.env, GIT_INDEX_FILE: indexPath });
}

async function gitAllowExit(args: string[], cwd: string, allowedExitCodes: number[]): Promise<string> {
  const proc = Bun.spawn(['git', ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const code = await proc.exited;
  const stdout = (await new Response(proc.stdout).text()).trim();
  const stderr = (await new Response(proc.stderr).text()).trim();
  if (!allowedExitCodes.includes(code)) {
    throw new Error(stderr || stdout || `git ${args.join(' ')} failed`);
  }
  return stdout;
}

async function gitIsAncestor(ancestor: string, descendant: string, cwd: string): Promise<boolean> {
  const proc = Bun.spawn(['git', '--no-replace-objects', 'merge-base', '--is-ancestor', ancestor, descendant], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const code = await proc.exited;
  return code === 0;
}

function isGitRepo(dir: string): boolean {
  return existsSync(join(dir, '.git'));
}

function parseStatusHeader(header: string): Pick<GitStatusDto, 'branch' | 'ahead' | 'behind'> {
  const branchPart = header
    .replace(/^##\s*/, '')
    .split('...')[0]
    ?.split(' [')[0]
    ?.trim();
  const aheadMatch = header.match(/ahead (\d+)/);
  const behindMatch = header.match(/behind (\d+)/);

  return {
    branch: branchPart || 'HEAD',
    ahead: aheadMatch ? Number(aheadMatch[1]) : 0,
    behind: behindMatch ? Number(behindMatch[1]) : 0,
  };
}

function parseStatusFile(line: string): GitFileChange | null {
  if (line.length < 4) return null;
  const index = line[0] ?? ' ';
  const workTree = line[1] ?? ' ';
  const path = line.slice(3).trim();
  if (!path) return null;

  return {
    path,
    index,
    workTree,
    staged: index !== ' ' && index !== '?',
    insertions: 0,
    deletions: 0,
  };
}

function parseNumstat(output: string): Map<string, { insertions: number; deletions: number }> {
  const stats = new Map<string, { insertions: number; deletions: number }>();
  for (const line of output.split('\n')) {
    if (!line.trim()) continue;
    const [insertionsRaw, deletionsRaw, ...pathParts] = line.split('\t');
    const path = pathParts.join('\t').trim();
    if (!path) continue;
    const insertions = insertionsRaw === '-' ? 0 : Number(insertionsRaw);
    const deletions = deletionsRaw === '-' ? 0 : Number(deletionsRaw);
    stats.set(path, {
      insertions: Number.isFinite(insertions) ? insertions : 0,
      deletions: Number.isFinite(deletions) ? deletions : 0,
    });
  }
  return stats;
}

function lineCount(text: string): number {
  if (text.length === 0) return 0;
  const newlines = text.match(/\n/g)?.length ?? 0;
  return text.endsWith('\n') ? newlines : newlines + 1;
}

function isInsideRepo(repoRoot: string, candidate: string): boolean {
  return candidate.startsWith(`${repoRoot}${sep}`);
}

function validateGitPath(path: string): string {
  const trimmed = path.trim();
  if (
    !trimmed ||
    trimmed.startsWith('-') ||
    trimmed.startsWith('/') ||
    trimmed.includes('\0') ||
    trimmed.split('/').includes('..')
  ) {
    throw new BadRequestException('Invalid path');
  }
  return trimmed;
}

function validateGitRevision(revision: string): string {
  const trimmed = revision.trim();
  if (!trimmed || trimmed.startsWith('-') || trimmed.includes('\0')) {
    throw new BadRequestException('Invalid base ref');
  }
  return trimmed;
}

function truncateDiff(diff: string): GitDiffDto {
  const maxDiffChars = 200_000;
  if (diff.length <= maxDiffChars) {
    return { diff, truncated: false };
  }
  return { diff: diff.slice(0, maxDiffChars), truncated: true };
}

function parseRemotePath(host: string, rawPath: string): RemoteInfoDto | null {
  const parts = rawPath.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);
  if (parts.length < 2) return null;
  const repo = parts.pop()!.replace(/\.git$/, '');
  if (!repo) return null;
  return { host, owner: parts.join('/'), repo };
}

function parseRemoteUrl(url: string): RemoteInfoDto | null {
  const sshMatch = url.match(/^git@([^:]+):(.+)$/);
  if (sshMatch) {
    return parseRemotePath(sshMatch[1], sshMatch[2]);
  }

  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return null;
    return parseRemotePath(parsed.host, parsed.pathname);
  } catch {
    return null;
  }
}

@Injectable()
export class GitService {
  constructor(private readonly settings: SettingsService) {}

  private get projectRoots(): string[] {
    const raw = this.settings.resolve('NUNCIO_PROJECT_ROOTS')?.trim();
    if (!raw) return [];
    return raw
      .split(',')
      .map((entry) => expandHome(entry.trim()))
      .filter(Boolean);
  }

  private get workspacesDir(): string {
    const raw = this.settings.resolve('NUNCIO_WORKSPACES_DIR')?.trim();
    return resolve(expandHome(raw || join(homedir(), '.nuncio', 'workspaces')));
  }

  async listProjects(): Promise<ProjectDto[]> {
    const projects: ProjectDto[] = [];
    const seen = new Set<string>();

    for (const root of this.projectRoots) {
      if (!existsSync(root)) continue;

      const entries: string[] = [];
      if (isGitRepo(root)) {
        entries.push(root);
      } else {
        for (const name of readdirSync(root)) {
          const child = join(root, name);
          try {
            if (statSync(child).isDirectory()) entries.push(child);
          } catch {
            // skip unreadable entries
          }
        }
      }

      for (const path of entries) {
        const resolved = resolve(path);
        if (!isGitRepo(resolved) || seen.has(resolved)) continue;
        seen.add(resolved);
        projects.push({
          id: resolved,
          name: basename(resolved),
          path: resolved,
          isGit: true,
        });
      }
    }

    return projects.sort((a, b) => a.name.localeCompare(b.name));
  }

  async resolveRepoRoot(path: string): Promise<string> {
    const normalized = expandHome(path.trim());
    try {
      const topLevel = await git(['rev-parse', '--show-toplevel'], normalized);
      return realpathSync.native(resolve(topLevel));
    } catch {
      throw new BadRequestException(`Not a git repository: ${path}`);
    }
  }

  async currentBranch(path: string): Promise<string | null> {
    try {
      const repoRoot = await this.resolveRepoRoot(path);
      const head = await git(['rev-parse', '--abbrev-ref', 'HEAD'], repoRoot);
      return head && head !== 'HEAD' ? head : null;
    } catch {
      return null;
    }
  }

  /** Read-only validation of a Crew-owned Git workspace boundary. */
  async inspectBoundary(
    path: string,
    expectation: string | GitBoundaryExpectation = {},
  ): Promise<GitBoundaryInspectionDto> {
    const normalizedExpectation = typeof expectation === 'string' || !expectation.expectedCanonicalPath
      ? expectation
      : { ...expectation, expectedCanonicalPath: expandHome(expectation.expectedCanonicalPath) };
    return inspectGitWorkspaceBoundary(expandHome(path), normalizedExpectation, {
      git: (args, cwd) => git(args, cwd),
      isAncestor: gitIsAncestor,
    });
  }

  /** Validate committed Builder output from one exact durable head to current HEAD. */
  async validateCheckpointRange(path: string, fromHead: string, toHead: string): Promise<void> {
    return validateGitCheckpointRange(expandHome(path), fromHead, toHead, {
      // Builder-controlled refs/replace must not rewrite the graph or blobs that
      // the acceptance scan sees.
      git: (args, cwd) => git(['--no-replace-objects', ...args], cwd),
      isAncestor: gitIsAncestor,
      readBlobs: readBoundedGitBlobs,
    });
  }

  /** Commit only the current workspace's changes; never pushes or rewrites. */
  async checkpoint(path: string, message: string): Promise<GitCheckpointResultDto> {
    return checkpointGitWorkspace(expandHome(path), message, {
      git: (args, cwd) => git(args, cwd),
      gitWithIndex,
      isAncestor: gitIsAncestor,
      readBlobs: readBoundedGitBlobs,
    });
  }

  async listBranches(projectPath: string): Promise<BranchDto[]> {
    const repoRoot = await this.resolveRepoRoot(projectPath);

    let current: string | null = null;
    try {
      const head = await git(['rev-parse', '--abbrev-ref', 'HEAD'], repoRoot);
      if (head && head !== 'HEAD') current = head;
    } catch {
      try {
        current = await git(['symbolic-ref', '--short', 'HEAD'], repoRoot);
      } catch {
        current = null;
      }
    }

    const output = await git(
      [
        'for-each-ref',
        '--format=%(refname)\t%(refname:short)\t%(symref)\t%(objectname)',
        'refs/heads',
        'refs/remotes',
      ],
      repoRoot,
    ).catch(() => git(['branch', '--all', '--format=%(refname)\t%(refname:short)\t\t%(objectname)'], repoRoot));

    const refs: Array<{ fullName: string; name: string; objectName: string }> = [];
    const localObjects = new Map<string, string>();
    const remoteDefaults: string[] = [];
    for (const line of output.split('\n')) {
      const trimmed = line.replace(/^\*\s*/, '').trim();
      if (!trimmed) continue;
      const parts = trimmed.split('\t');
      const fullName = parts.length >= 2 ? parts[0]?.trim() ?? '' : '';
      const name = parts.length >= 2 ? parts[1]?.trim() ?? '' : parts[0]?.trim() ?? '';
      const symref = parts.length >= 3 ? parts[2]?.trim() ?? '' : '';
      const objectName = parts.length >= 4 ? parts[3]?.trim() ?? '' : '';
      if (symref) {
        if (fullName.startsWith('refs/remotes/') && fullName.endsWith('/HEAD')) {
          remoteDefaults.push(symref.replace('refs/remotes/', ''));
        }
        continue;
      }
      if (!name || name === 'HEAD' || name.endsWith('/HEAD')) continue;
      refs.push({ fullName, name, objectName });
      if (fullName.startsWith('refs/heads/')) localObjects.set(name, objectName);
    }

    const names = new Set<string>();
    for (const ref of refs) {
      if (ref.fullName.startsWith('refs/remotes/')) {
        const localName = ref.name.replace(/^[^/]+\//, '');
        const localObject = localObjects.get(localName);
        if (localObject && ref.objectName && localObject === ref.objectName) continue;
      }
      names.add(ref.name);
    }

    if (names.size === 0 && current) {
      names.add(current);
    }

    if (names.size === 0) {
      return [];
    }

    let defaultBranch = current ?? 'main';
    const remoteDefault = remoteDefaults.sort((a, b) => {
      if (a.startsWith('origin/')) return -1;
      if (b.startsWith('origin/')) return 1;
      return a.localeCompare(b);
    }).find((candidate) => {
      const localCandidate = candidate.replace(/^[^/]+\//, '');
      return names.has(localCandidate) || names.has(candidate);
    });
    if (remoteDefault) {
      const localDefault = remoteDefault.replace(/^[^/]+\//, '');
      defaultBranch = names.has(localDefault) ? localDefault : remoteDefault;
    } else {
      if (names.has('main')) defaultBranch = 'main';
      else if (names.has('master')) defaultBranch = 'master';
      else if (current) defaultBranch = current;
      else defaultBranch = [...names][0] ?? 'main';
    }

    return [...names]
      .sort((a, b) => a.localeCompare(b))
      .map((name) => ({
        name,
        isDefault: name === defaultBranch,
        isCurrent: current !== null && name === current,
      }));
  }

  async createWorktree(
    projectPath: string,
    baseBranch: string | undefined,
    sessionId: string,
    slug: string,
  ): Promise<WorktreeResult> {
    const repoRoot = await this.resolveRepoRoot(projectPath);
    const safeSlug = sanitizeSlug(slug);
    const branch = `nuncio/${sessionId}-${safeSlug}`.slice(0, 120);
    const worktreePath = join(this.workspacesDir, sessionId);

    // Resolve the repo's actual default branch when the caller omits baseBranch,
    // instead of assuming "main" — repos may use develop/master/etc.
    const resolvedBase = baseBranch?.trim() || (await this.resolveDefaultBranch(repoRoot));
    const worktreeBase = await this.resolveWorktreeBase(repoRoot, resolvedBase);

    try {
      await git(
        ['worktree', 'add', '-b', branch, worktreePath, worktreeBase],
        repoRoot,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new BadRequestException(`Failed to create worktree: ${message}`);
    }

    return { worktreePath, branch, baseBranch: resolvedBase };
  }

  async fetchPullRequestHead(
    projectPath: string,
    provider: 'github' | 'gitlab',
    number: number,
  ): Promise<string> {
    if (!Number.isInteger(number) || number <= 0) {
      throw new BadRequestException('Pull request number must be a positive integer');
    }
    const repoRoot = await this.resolveRepoRoot(projectPath);
    const remoteRef = provider === 'github'
      ? `refs/pull/${number}/head`
      : `refs/merge-requests/${number}/head`;
    const localRef = `refs/nuncio/pull-requests/${provider}/${number}`;
    try {
      await git(['fetch', '--force', 'origin', `${remoteRef}:${localRef}`], repoRoot);
      return localRef;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new BadRequestException(`Failed to fetch pull request head: ${message}`);
    }
  }

  async fetchRemoteBranch(projectPath: string, branch: string): Promise<string> {
    const repoRoot = await this.resolveRepoRoot(projectPath);
    const remoteBranch = branch.trim();
    try {
      await git(['check-ref-format', '--branch', remoteBranch], repoRoot);
      await git([
        'fetch',
        '--force',
        'origin',
        `refs/heads/${remoteBranch}:refs/remotes/origin/${remoteBranch}`,
      ], repoRoot);
      return `origin/${remoteBranch}`;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new BadRequestException(`Failed to fetch source branch: ${message}`);
    }
  }

  async setWorktreeUpstream(
    worktreePath: string,
    localBranch: string,
    upstreamBranch: string,
  ): Promise<void> {
    const repoRoot = await this.resolveRepoRoot(worktreePath);
    const remotePrefix = 'origin/';
    const remoteBranch = upstreamBranch.startsWith(remotePrefix)
      ? upstreamBranch.slice(remotePrefix.length)
      : '';
    try {
      await git(['check-ref-format', '--branch', localBranch], repoRoot);
      await git(['check-ref-format', '--branch', remoteBranch], repoRoot);
      await git(['rev-parse', '--verify', `refs/remotes/${upstreamBranch}^{commit}`], repoRoot);
      await git(['branch', '--set-upstream-to', upstreamBranch, localBranch], repoRoot);
      await git(['config', 'extensions.worktreeConfig', 'true'], repoRoot);
      await git(['config', '--worktree', 'push.default', 'upstream'], repoRoot);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new BadRequestException(`Failed to configure source branch upstream: ${message}`);
    }
  }

  private async resolveWorktreeBase(repoRoot: string, base: string): Promise<string> {
    const candidates = base.startsWith('refs/')
      ? [base]
      : [`refs/heads/${base}`, `refs/remotes/origin/${base}`, base];
    for (const candidate of candidates) {
      try {
        await git(['rev-parse', '--verify', `${candidate}^{commit}`], repoRoot);
        return candidate;
      } catch {
        // Try the next exact namespace before letting worktree add report failure.
      }
    }
    return base;
  }

  private async resolveDefaultBranch(repoRoot: string): Promise<string> {
    try {
      const branches = await this.listBranches(repoRoot);
      const def = branches.find((b) => b.isDefault);
      if (def) return def.name;
      if (branches.length > 0) return branches[0].name;
    } catch {
      // fall through to 'main' as a last resort
    }
    return 'main';
  }

  /**
   * Cheap dirty-check for the rung-3 empty-diff anomaly (sub-phase C): a bare
   * `git status --porcelain` (no branch header, no numstat) — any non-empty line
   * means uncommitted work exists. Much lighter than {@link status}, so it is safe
   * to run per RUNNING session on the heartbeat sweep. A non-repo path → false
   * (nothing to change), never a throw.
   */
  async hasChanges(path: string): Promise<boolean> {
    try {
      const repoRoot = await this.resolveRepoRoot(path);
      const output = await git(['status', '--porcelain'], repoRoot);
      return output.trim().length > 0;
    } catch {
      return false;
    }
  }

  async status(path: string): Promise<GitStatusDto> {
    const repoRoot = await this.resolveRepoRoot(path);
    const output = await git(['status', '--porcelain=v1', '-b'], repoRoot);
    const lines = output.split('\n').filter(Boolean);
    const header = lines.find((line) => line.startsWith('## ')) ?? '## HEAD';
    const branchState = parseStatusHeader(header);
    const files = lines
      .filter((line) => !line.startsWith('## '))
      .map(parseStatusFile)
      .filter((file): file is GitFileChange => file !== null);

    await this.populateFileStats(repoRoot, files);

    return {
      ...branchState,
      clean: files.length === 0,
      files,
    };
  }

  /**
   * Commits on HEAD that are not yet on the push target: configured upstream,
   * else `origin/<branch>`, else optional `fallbackBase` (session baseBranch).
   */
  async unpushedCommits(
    path: string,
    options: { fallbackBase?: string | null } = {},
  ): Promise<GitUnpushedCommitsDto> {
    const sync = await this.branchSync(path, options);
    return {
      branch: sync.branch,
      base: sync.base,
      commits: sync.outgoing,
    };
  }

  async branchSync(
    path: string,
    options: { fallbackBase?: string | null } = {},
  ): Promise<GitBranchSyncDto> {
    const repoRoot = await this.resolveRepoRoot(path);
    const branch = await this.currentBranchName(repoRoot);
    const base = await this.resolveUnpushedBase(repoRoot, branch, options.fallbackBase);
    return computeBranchSync((args, cwd) => git(args, cwd), repoRoot, branch, base);
  }

  async commitDiff(path: string, sha: string): Promise<GitDiffDto> {
    const repoRoot = await this.resolveRepoRoot(path);
    const revision = validateGitRevision(sha);
    return showCommitDiff((args, cwd) => git(args, cwd), repoRoot, revision);
  }

  async stashList(path: string): Promise<GitStashEntryDto[]> {
    const repoRoot = await this.resolveRepoRoot(path);
    return listStashes((args, cwd) => git(args, cwd), repoRoot);
  }

  async blame(path: string, filePath: string): Promise<GitBlameDto> {
    const repoRoot = await this.resolveRepoRoot(path);
    return blameFile(
      (args, cwd) => git(args, cwd),
      repoRoot,
      filePath,
      validateGitPath,
    );
  }

  async history(
    path: string,
    options: { limit?: number } = {},
  ): Promise<GitHistoryDto> {
    const repoRoot = await this.resolveRepoRoot(path);
    const branch = await this.currentBranchName(repoRoot);
    return loadHistory(
      (args, cwd) => git(args, cwd),
      repoRoot,
      branch,
      options.limit,
    );
  }

  async pull(path: string): Promise<PullResultDto> {
    const repoRoot = await this.resolveRepoRoot(path);
    return pullRemote((args, cwd) => git(args, cwd), repoRoot);
  }

  private async currentBranchName(repoRoot: string): Promise<string> {
    try {
      const name = await git(['rev-parse', '--abbrev-ref', 'HEAD'], repoRoot);
      return name || 'HEAD';
    } catch {
      return 'HEAD';
    }
  }

  private async resolveUnpushedBase(
    repoRoot: string,
    branch: string,
    fallbackBase?: string | null,
  ): Promise<string | null> {
    try {
      const upstream = await git(['rev-parse', '--abbrev-ref', '@{upstream}'], repoRoot);
      if (upstream) return upstream;
    } catch {
      // No upstream configured.
    }

    if (branch && branch !== 'HEAD') {
      const remoteRef = `origin/${branch}`;
      try {
        await git(['rev-parse', '--verify', remoteRef], repoRoot);
        return remoteRef;
      } catch {
        // Remote branch does not exist yet (never pushed).
      }
    }

    const fallback = fallbackBase?.trim();
    if (fallback) {
      try {
        return validateGitRevision(fallback);
      } catch {
        return null;
      }
    }

    return null;
  }

  private async populateFileStats(repoRoot: string, files: GitFileChange[]): Promise<void> {
    let trackedStats = new Map<string, { insertions: number; deletions: number }>();
    try {
      trackedStats = parseNumstat(await git(['diff', '--numstat', 'HEAD', '--'], repoRoot));
    } catch {
      trackedStats = new Map();
    }

    for (const file of files) {
      const stats = trackedStats.get(file.path);
      if (stats) {
        file.insertions = stats.insertions;
        file.deletions = stats.deletions;
        continue;
      }

      if (file.index !== '?') continue;
      file.insertions = this.countUntrackedLines(repoRoot, file.path);
      file.deletions = 0;
    }
  }

  private countUntrackedLines(repoRoot: string, path: string): number {
    if (path.endsWith('/')) return 0;
    try {
      const candidate = resolve(repoRoot, path);
      const real = realpathSync.native(candidate);
      if (!isInsideRepo(repoRoot, real)) return 0;
      if (!statSync(real).isFile()) return 0;
      return lineCount(readFileSync(real, 'utf8'));
    } catch {
      return 0;
    }
  }

  async diff(
    path: string,
    options: { staged?: boolean; base?: string; path?: string } = {},
  ): Promise<GitDiffDto> {
    const repoRoot = await this.resolveRepoRoot(path);

    if (options.path !== undefined) {
      const filePath = validateGitPath(options.path);
      const output = await this.diffPath(repoRoot, filePath);
      return truncateDiff(output);
    }

    const args = ['diff'];
    if (options.staged === true) {
      args.push('--staged');
    } else if (options.base?.trim()) {
      // Guard against option injection (e.g. `--output=`): a base beginning with
      // `-` would be parsed as a git flag, not a revision.
      const base = validateGitRevision(options.base);
      args.push(base, '--');
    }

    let output = await git(args, repoRoot);
    if (options.staged !== true) {
      const untracked = await this.diffUntrackedFiles(repoRoot);
      output = [output, untracked].filter(Boolean).join('\n');
    }
    return truncateDiff(output);
  }

  private async diffUntrackedFiles(repoRoot: string): Promise<string> {
    const status = await git(['status', '--porcelain=v1', '-uall'], repoRoot).catch(() => '');
    const diffs: string[] = [];

    for (const line of status.split('\n')) {
      if (!line.startsWith('?? ')) continue;
      const path = line.slice(3).trim();
      if (!path || path.endsWith('/')) continue;

      const candidate = resolve(repoRoot, path);
      let real: string;
      try {
        real = realpathSync.native(candidate);
      } catch {
        continue;
      }
      if (!isInsideRepo(repoRoot, real) || !statSync(real).isFile()) continue;
      diffs.push(await gitAllowExit(['diff', '--no-index', '--', '/dev/null', path], repoRoot, [0, 1]));
    }

    return diffs.filter(Boolean).join('\n');
  }

  async resolveWorktreeDiffBase(path: string, baseBranch?: string | null): Promise<string | null> {
    const repoRoot = await this.resolveRepoRoot(path);
    const base = validateGitRevision(baseBranch?.trim() || (await this.resolveDefaultBranch(repoRoot)));
    try {
      return await git(['merge-base', 'HEAD', base], repoRoot);
    } catch {
      return base;
    }
  }

  private async diffPath(repoRoot: string, path: string): Promise<string> {
    let output: string;
    if (await this.hasHead(repoRoot)) {
      output = await git(['diff', 'HEAD', '--', path], repoRoot);
    } else {
      output = await git(['diff', '--', path], repoRoot);
    }

    if (output) return output;

    const status = await git(['status', '--porcelain=v1', '--', path], repoRoot).catch(() => '');
    const isUntracked = status
      .split('\n')
      .some((line) => line.startsWith('?? '));
    if (!isUntracked) return output;

    const candidate = resolve(repoRoot, path);
    const real = realpathSync.native(candidate);
    if (!isInsideRepo(repoRoot, real)) {
      throw new BadRequestException('Invalid path');
    }
    if (!statSync(real).isFile()) return output;

    return gitAllowExit(['diff', '--no-index', '--', '/dev/null', path], repoRoot, [0, 1]);
  }

  private async hasHead(repoRoot: string): Promise<boolean> {
    try {
      await git(['rev-parse', '--verify', 'HEAD'], repoRoot);
      return true;
    } catch {
      return false;
    }
  }

  async stageAll(path: string): Promise<void> {
    const repoRoot = await this.resolveRepoRoot(path);
    await git(['add', '-A'], repoRoot);
  }

  async commit(path: string, message: string): Promise<CommitResultDto> {
    const repoRoot = await this.resolveRepoRoot(path);
    const trimmed = message.trim();
    if (!trimmed) {
      throw new BadRequestException('Commit message is required');
    }

    try {
      await git(['commit', '-m', trimmed], repoRoot);
      const sha = await git(['rev-parse', 'HEAD'], repoRoot);
      return { sha, committed: true };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new BadRequestException(`Failed to commit changes: ${errorMessage}`);
    }
  }

  async remoteInfo(path: string): Promise<RemoteInfoDto> {
    const repoRoot = await this.resolveRepoRoot(path);
    try {
      const remoteUrl = await git(['remote', 'get-url', 'origin'], repoRoot);
      const info = parseRemoteUrl(remoteUrl);
      if (!info) {
        throw new BadRequestException(`Unsupported origin remote URL: ${remoteUrl}`);
      }
      return info;
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new BadRequestException(`Failed to read origin remote: ${errorMessage}`);
    }
  }

  async push(
    path: string,
    branch: string,
    options: { force?: boolean; remoteBranch?: string } = {},
  ): Promise<PushResultDto> {
    const repoRoot = await this.resolveRepoRoot(path);
    const localBranch = branch.trim();
    const remoteBranch = options.remoteBranch?.trim() || localBranch;
    if (!localBranch || !remoteBranch || remoteBranch.startsWith('-')) {
      throw new BadRequestException('Branch is required');
    }

    const refspec = localBranch === remoteBranch
      ? localBranch
      : `${localBranch}:refs/heads/${remoteBranch.replace(/^refs\/heads\//, '')}`;
    const args = ['push', 'origin', refspec];
    if (options.force === true) {
      args.push('--force-with-lease');
    }

    try {
      await git(args, repoRoot);
      if (localBranch !== remoteBranch) {
        await git(
          ['branch', '--set-upstream-to', `origin/${remoteBranch}`, localBranch],
          repoRoot,
        ).catch(() => '');
      }
      return { pushed: true, remoteBranch };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new BadRequestException(`Failed to push branch: ${errorMessage}`);
    }
  }

  async removeWorktreeIfSafe(
    repoRoot: string,
    worktreePath: string,
    options: { fallbackBase?: string | null } = {},
  ): Promise<{ removed: boolean; reason?: string }> {
    let resolvedWorktree: string;
    let headLock: string;
    try {
      resolvedWorktree = await this.resolveRepoRoot(worktreePath);
      const gitDirValue = await git(['rev-parse', '--git-dir'], resolvedWorktree);
      headLock = join(resolve(resolvedWorktree, gitDirValue), 'HEAD.lock');
    } catch {
      return { removed: false, reason: 'worktree-missing' };
    }
    let lockFd: number;
    try {
      lockFd = openSync(headLock, 'wx');
    } catch {
      return { removed: false, reason: 'worktree-busy' };
    }

    try {
      const status = await this.status(resolvedWorktree);
      if (!status.clean) return { removed: false, reason: 'dirty-after-archive' };
      const unpushed = await this.unpushedCommits(resolvedWorktree, options);
      if (unpushed.commits.length > 0) {
        return { removed: false, reason: 'unpushed-after-archive' };
      }
      await git(['worktree', 'remove', worktreePath], await this.resolveRepoRoot(repoRoot));
      return { removed: true };
    } catch {
      return { removed: false, reason: 'worktree-removal-failed' };
    } finally {
      closeSync(lockFd);
      try {
        unlinkSync(headLock);
      } catch {
        // Successful removal deletes the linked-worktree metadata and its lock.
      }
    }
  }

  async removeWorktree(
    repoRoot: string,
    worktreePath: string,
    options: { force?: boolean; bestEffort?: boolean } = { force: true, bestEffort: true },
  ): Promise<void> {
    try {
      await git(
        ['worktree', 'remove', ...(options.force === false ? [] : ['--force']), worktreePath],
        repoRoot,
      );
    } catch (error) {
      if (options.bestEffort !== false) return;
      const message = error instanceof Error ? error.message : String(error);
      throw new BadRequestException(`Failed to remove worktree: ${message}`);
    }
  }
}
