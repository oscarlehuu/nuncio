import { Injectable } from '@nestjs/common';
import { GitService } from '../git/git.service';
import { SettingsService } from '../settings/settings.service';
import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { CrewWorkspacePort } from './crew-execution.ports';

@Injectable()
export class CrewGitWorkspaceAdapter implements CrewWorkspacePort {
  constructor(private readonly git: GitService, private readonly settings: SettingsService) {}
  async resolveBase(projectPath: string, requested?: string | null) {
    const baseBranch = requested?.trim() || await this.defaultBranch(projectPath);
    const baseHead = await gitValue(projectPath, ['rev-parse', '--verify', `${baseBranch}^{commit}`]);
    return { baseBranch, baseHead };
  }
  async fileExistsAtRevision(projectPath: string, revision: string, relativePath: string) {
    const entry = await gitValue(projectPath, ['ls-tree', revision, '--', relativePath]);
    return /^(100644|100755) blob [0-9a-f]+\t/.test(entry);
  }
  async createWorktree(input: {
    runId: string; projectPath: string; baseBranch: string; baseHead: string; slug: string;
  }) {
    const baseBranch = input.baseBranch.trim();
    const baseHead = input.baseHead.trim();
    if (!baseBranch || !baseHead) throw new Error('Crew frozen base metadata is missing');
    const branch = `nuncio/${input.runId}-${sanitizeSlug(input.slug)}`.slice(0, 120);
    const worktreePath = join(this.workspacesDir(), input.runId);
    if (existsSync(worktreePath)) {
      const boundary = await this.git.inspectBoundary(worktreePath, {
        expectedBranch: branch, expectedCanonicalPath: worktreePath, expectedAncestorHead: baseHead,
      });
      if (!boundary.ok || !boundary.clean || boundary.fullHead !== baseHead
        || await gitCommonDir(input.projectPath) !== await gitCommonDir(worktreePath)) {
        const reason = boundary.fullHead !== baseHead ? 'not at the frozen base head' : boundary.reason;
        throw new Error(`Existing Crew worktree cannot be reconciled: ${reason ?? 'repository mismatch'}`);
      }
      return { worktreePath: boundary.canonicalPath, branch, baseBranch };
    }
    const branchOnly = await this.reconcileBranchOnly(
      input.projectPath, worktreePath, branch, baseBranch, baseHead,
    );
    if (branchOnly) return branchOnly;
    try {
      await gitValue(input.projectPath, ['worktree', 'add', '-b', branch, worktreePath, baseHead]);
      const boundary = await this.git.inspectBoundary(worktreePath, {
        expectedBranch: branch, expectedCanonicalPath: worktreePath, expectedAncestorHead: baseHead,
      });
      if (!boundary.ok || !boundary.clean || boundary.fullHead !== baseHead
        || await gitCommonDir(input.projectPath) !== await gitCommonDir(worktreePath)) {
        throw new Error(`Created Crew worktree is not at the frozen base head: ${boundary.reason ?? 'mismatch'}`);
      }
      return { worktreePath: boundary.canonicalPath, branch, baseBranch };
    } catch (error) {
      if (!existsSync(worktreePath)) {
        const recovered = await this.reconcileBranchOnly(
          input.projectPath, worktreePath, branch, baseBranch, baseHead,
        );
        if (recovered) return recovered;
        throw new Error(`Crew worktree has partial branch/path state: ${reasonOf(error)}`);
      }
      throw error;
    }
  }
  async inspectBoundary(path: string, expectation?: string | {
    expectedBranch?: string; expectedAncestorHead?: string; expectedCanonicalPath?: string;
  } | null) {
    return this.git.inspectBoundary(path, expectation ?? {});
  }
  async checkpoint(path: string, message: string) {
    return this.git.checkpoint(path, message);
  }
  async validateCheckpointRange(path: string, fromHead: string, toHead: string): Promise<void> {
    await this.git.validateCheckpointRange(path, fromHead, toHead);
  }
  async diff(path: string, baseRevision?: string | null) {
    return this.git.diff(path, { ...(baseRevision ? { base: baseRevision } : {}) });
  }
  private async reconcileBranchOnly(
    projectPath: string, worktreePath: string, branch: string, baseBranch: string, baseHead: string,
  ): Promise<{ worktreePath: string; branch: string; baseBranch: string } | null> {
    const branchHead = await gitOptionalValue(projectPath, ['rev-parse', '--verify', `refs/heads/${branch}`]);
    if (!branchHead) return null;
    if (branchHead !== baseHead) throw new Error('Existing Crew branch-only state is not at the frozen base head');
    const worktrees = await gitValue(projectPath, ['worktree', 'list', '--porcelain']);
    if (worktrees.split('\n').some((line) => line === `branch refs/heads/${branch}`)) {
      throw new Error('Existing Crew branch-only state is already attached to another worktree');
    }
    await gitValue(projectPath, ['worktree', 'add', worktreePath, branch]);
    const boundary = await this.git.inspectBoundary(worktreePath, {
      expectedBranch: branch, expectedCanonicalPath: worktreePath, expectedAncestorHead: baseHead,
    });
    if (!boundary.ok || !boundary.clean || boundary.fullHead !== baseHead
      || await gitCommonDir(projectPath) !== await gitCommonDir(worktreePath)) {
      throw new Error(`Existing Crew branch-only state cannot be reconciled: ${boundary.reason ?? 'repository mismatch'}`);
    }
    return { worktreePath: boundary.canonicalPath, branch, baseBranch };
  }
  private workspacesDir(): string {
    const configured = this.settings.resolve('NUNCIO_WORKSPACES_DIR')?.trim();
    const raw = configured || join(homedir(), '.nuncio', 'workspaces');
    return resolve(raw.startsWith('~/') ? join(homedir(), raw.slice(2)) : raw);
  }
  private async defaultBranch(projectPath: string): Promise<string> {
    const branches = await this.git.listBranches(projectPath);
    return branches.find((branch) => branch.isDefault)?.name
      ?? branches.find((branch) => branch.isCurrent)?.name
      ?? branches[0]?.name
      ?? 'main';
  }
}

function sanitizeSlug(slug: string): string {
  return slug.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 30).replace(/^-|-$/g, '') || 'task';
}
async function gitValue(cwd: string, args: string[]): Promise<string> {
  const process = Bun.spawn(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (await process.exited !== 0) throw new Error((await new Response(process.stderr).text()).trim());
  return (await new Response(process.stdout).text()).trim();
}
async function gitOptionalValue(cwd: string, args: string[]): Promise<string | null> {
  try { return await gitValue(cwd, args); } catch { return null; }
}
async function gitCommonDir(cwd: string): Promise<string> {
  const value = await gitValue(cwd, ['rev-parse', '--git-common-dir']);
  return realpathSync.native(resolve(cwd, value));
}
function reasonOf(error: unknown): string { return error instanceof Error ? error.message : String(error); }
