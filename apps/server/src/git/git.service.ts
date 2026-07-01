import { BadRequestException, Injectable } from '@nestjs/common';
import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { SettingsService } from '../settings/settings.service';
import type {
  BranchDto,
  CommitResultDto,
  GitDiffDto,
  GitFileChange,
  GitStatusDto,
  ProjectDto,
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

async function git(args: string[], cwd?: string): Promise<string> {
  const proc = Bun.spawn(['git', ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const code = await proc.exited;
  const stdout = (await new Response(proc.stdout).text()).trim();
  const stderr = (await new Response(proc.stderr).text()).trim();
  if (code !== 0) {
    throw new Error(stderr || stdout || `git ${args.join(' ')} failed`);
  }
  return stdout;
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
  };
}

function truncateDiff(diff: string): GitDiffDto {
  const maxDiffChars = 200_000;
  if (diff.length <= maxDiffChars) {
    return { diff, truncated: false };
  }
  return { diff: diff.slice(0, maxDiffChars), truncated: true };
}

function parseRemoteUrl(url: string): RemoteInfoDto | null {
  const sshMatch = url.match(/^git@([^:]+):([^/]+)\/(.+?)(?:\.git)?$/);
  if (sshMatch) {
    return { host: sshMatch[1], owner: sshMatch[2], repo: sshMatch[3] };
  }

  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return null;
    const [owner, repoWithSuffix] = parsed.pathname.replace(/^\/+/, '').split('/');
    if (!owner || !repoWithSuffix) return null;
    return { host: parsed.host, owner, repo: repoWithSuffix.replace(/\.git$/, '') };
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

    const output = await git(['branch', '--format=%(refname:short)\t%(refname:short)'], repoRoot).catch(
      () => git(['branch'], repoRoot),
    );

    const names = new Set<string>();
    for (const line of output.split('\n')) {
      const trimmed = line.replace(/^\*\s*/, '').trim();
      if (!trimmed) continue;
      const name = trimmed.split('\t')[0]?.trim() ?? trimmed;
      if (name && name !== 'HEAD') names.add(name);
    }

    if (names.size === 0 && current) {
      names.add(current);
    }

    if (names.size === 0) {
      return [];
    }

    let defaultBranch = current ?? 'main';
    try {
      const symref = await git(['symbolic-ref', 'refs/remotes/origin/HEAD'], repoRoot);
      defaultBranch = symref.replace('refs/remotes/origin/', '');
    } catch {
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

    try {
      await git(
        ['worktree', 'add', '-b', branch, worktreePath, resolvedBase],
        repoRoot,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new BadRequestException(`Failed to create worktree: ${message}`);
    }

    return { worktreePath, branch };
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

    return {
      ...branchState,
      clean: files.length === 0,
      files,
    };
  }

  async diff(
    path: string,
    options: { staged?: boolean; base?: string } = {},
  ): Promise<GitDiffDto> {
    const repoRoot = await this.resolveRepoRoot(path);
    const args = ['diff'];
    if (options.staged === true) {
      args.push('--staged');
    } else if (options.base?.trim()) {
      const base = options.base.trim();
      // Guard against option injection (e.g. `--output=`): a `base` beginning with
      // `-` would be parsed as a git flag, not a revision. Reject it and pin the
      // value as a revision with a trailing `--`.
      if (base.startsWith('-')) {
        throw new BadRequestException('Invalid base ref');
      }
      args.push(base, '--');
    }

    const output = await git(args, repoRoot);
    return truncateDiff(output);
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
    options: { force?: boolean } = {},
  ): Promise<PushResultDto> {
    const repoRoot = await this.resolveRepoRoot(path);
    const remoteBranch = branch.trim();
    if (!remoteBranch) {
      throw new BadRequestException('Branch is required');
    }

    const args = ['push', 'origin', remoteBranch];
    if (options.force === true) {
      args.push('--force-with-lease');
    }

    try {
      await git(args, repoRoot);
      return { pushed: true, remoteBranch };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new BadRequestException(`Failed to push branch: ${errorMessage}`);
    }
  }

  async removeWorktree(repoRoot: string, worktreePath: string): Promise<void> {
    try {
      await git(['worktree', 'remove', '--force', worktreePath], repoRoot);
    } catch {
      // best-effort cleanup for tests
    }
  }
}
