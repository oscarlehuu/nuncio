import { BadRequestException, Injectable } from '@nestjs/common';
import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import type { BranchDto, ProjectDto, WorktreeResult } from './git.types';

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

@Injectable()
export class GitService {
  private get projectRoots(): string[] {
    const raw = process.env.NUNCIO_PROJECT_ROOTS?.trim();
    if (!raw) return [];
    return raw
      .split(',')
      .map((entry) => expandHome(entry.trim()))
      .filter(Boolean);
  }

  private get workspacesDir(): string {
    const raw = process.env.NUNCIO_WORKSPACES_DIR?.trim();
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
    try {
      const topLevel = await git(['rev-parse', '--show-toplevel'], path);
      return realpathSync.native(resolve(topLevel));
    } catch {
      throw new BadRequestException(`Not a git repository: ${path}`);
    }
  }

  async listBranches(projectPath: string): Promise<BranchDto[]> {
    const repoRoot = await this.resolveRepoRoot(projectPath);
    let current = 'main';
    try {
      current = await git(['rev-parse', '--abbrev-ref', 'HEAD'], repoRoot);
    } catch {
      // detached HEAD or empty repo — keep default
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

    let defaultBranch = 'main';
    try {
      const symref = await git(['symbolic-ref', 'refs/remotes/origin/HEAD'], repoRoot);
      defaultBranch = symref.replace('refs/remotes/origin/', '');
    } catch {
      if (names.has('main')) defaultBranch = 'main';
      else if (names.has('master')) defaultBranch = 'master';
      else if (current !== 'HEAD') defaultBranch = current;
    }

    return [...names]
      .sort((a, b) => a.localeCompare(b))
      .map((name) => ({
        name,
        isDefault: name === defaultBranch,
        isCurrent: name === current,
      }));
  }

  async createWorktree(
    projectPath: string,
    baseBranch: string,
    sessionId: string,
    slug: string,
  ): Promise<WorktreeResult> {
    const repoRoot = await this.resolveRepoRoot(projectPath);
    const safeSlug = sanitizeSlug(slug);
    const branch = `nuncio/${sessionId}-${safeSlug}`.slice(0, 120);
    const worktreePath = join(this.workspacesDir, sessionId);

    try {
      await git(
        ['worktree', 'add', '-b', branch, worktreePath, baseBranch],
        repoRoot,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new BadRequestException(`Failed to create worktree: ${message}`);
    }

    return { worktreePath, branch };
  }

  async removeWorktree(repoRoot: string, worktreePath: string): Promise<void> {
    try {
      await git(['worktree', 'remove', '--force', worktreePath], repoRoot);
    } catch {
      // best-effort cleanup for tests
    }
  }
}
