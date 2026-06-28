import { BadRequestException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { DatabaseModule } from '../../../src/db/database.module';
import { GitModule } from '../../../src/git/git.module';
import { GitService } from '../../../src/git/git.service';

async function runGitAsync(cwd: string, args: string[]): Promise<void> {
  const proc = Bun.spawn(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  const code = await proc.exited;
  if (code !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`git ${args.join(' ')} failed: ${stderr}`);
  }
}

async function initRepo(dir: string, branch = 'main'): Promise<void> {
  mkdirSync(dir, { recursive: true });
  await runGitAsync(dir, ['init', '-b', branch]);
  writeFileSync(join(dir, 'README.md'), '# test\n');
  await runGitAsync(dir, ['add', 'README.md']);
  await runGitAsync(dir, ['config', 'user.email', 'test@nuncio.local']);
  await runGitAsync(dir, ['config', 'user.name', 'Nuncio Test']);
  await runGitAsync(dir, ['commit', '-m', 'init']);
}

describe('GitService', () => {
  let module: TestingModule;
  let service: GitService;
  let rootsDir: string;
  let workspacesDir: string;
  let dataDir: string;
  let repoA: string;
  let repoB: string;
  let nestedRepo: string;

  beforeAll(async () => {
    rootsDir = mkdtempSync(join(tmpdir(), 'nuncio-roots-'));
    workspacesDir = mkdtempSync(join(tmpdir(), 'nuncio-ws-'));
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-git-data-'));
    process.env.NUNCIO_DATA_DIR = dataDir;
    process.env.NUNCIO_PROJECT_ROOTS = rootsDir;
    process.env.NUNCIO_WORKSPACES_DIR = workspacesDir;

    repoA = join(rootsDir, 'project-a');
    repoB = join(rootsDir, 'project-b');
    nestedRepo = join(rootsDir, 'nested', 'inner-repo');

    await initRepo(repoA);
    await initRepo(repoB, 'develop');
    mkdirSync(join(rootsDir, 'nested'), { recursive: true });
    await initRepo(nestedRepo);

    module = await Test.createTestingModule({
      imports: [DatabaseModule, GitModule],
    }).compile();
    service = module.get(GitService);
  });

  afterAll(async () => {
    await module.close();
    rmSync(rootsDir, { recursive: true, force: true });
    rmSync(workspacesDir, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.NUNCIO_DATA_DIR;
    delete process.env.NUNCIO_PROJECT_ROOTS;
    delete process.env.NUNCIO_WORKSPACES_DIR;
  });

  it('listProjects returns git repos one level under configured roots', async () => {
    const projects = await service.listProjects();
    const paths = projects.map((p) => p.path).sort();
    expect(paths).toEqual([repoA, repoB].sort());
    expect(projects.every((p) => p.isGit)).toBe(true);
    expect(projects.find((p) => p.path === repoA)?.name).toBe('project-a');
  });

  it('listBranches returns branch names for a repo', async () => {
    const branches = await service.listBranches(repoA);
    expect(branches.some((b) => b.name === 'main')).toBe(true);
    expect(branches.find((b) => b.name === 'main')?.isDefault).toBe(true);
  });

  it('listBranches resolves subdir to repo root via rev-parse', async () => {
    const subdir = join(repoA, 'src');
    mkdirSync(subdir, { recursive: true });
    const branches = await service.listBranches(subdir);
    expect(branches.some((b) => b.name === 'main')).toBe(true);
  });

  it('listBranches returns the unborn branch when the repo has no commits yet', async () => {
    const emptyRepo = mkdtempSync(join(tmpdir(), 'nuncio-empty-repo-'));
    try {
      await runGitAsync(emptyRepo, ['init', '-b', 'master']);
      const branches = await service.listBranches(emptyRepo);
      expect(branches).toEqual([
        { name: 'master', isDefault: true, isCurrent: true },
      ]);
    } finally {
      rmSync(emptyRepo, { recursive: true, force: true });
    }
  });

  it('listBranches expands tilde paths under the home directory', async () => {
    const homeRepo = join(homedir(), `.nuncio-git-tilde-${Date.now()}`);
    try {
      await initRepo(homeRepo);
      const tildePath = `~${homeRepo.slice(homedir().length)}`;
      const branches = await service.listBranches(tildePath);
      expect(branches.some((b) => b.name === 'main')).toBe(true);
    } finally {
      rmSync(homeRepo, { recursive: true, force: true });
    }
  });

  it('listBranches rejects non-git paths', async () => {
    const notRepo = mkdtempSync(join(tmpdir(), 'not-git-'));
    try {
      await expect(service.listBranches(notRepo)).rejects.toBeInstanceOf(BadRequestException);
    } finally {
      rmSync(notRepo, { recursive: true, force: true });
    }
  });

  it('createWorktree creates nuncio branch and worktree directory', async () => {
    const sessionId = 'abc12345';
    const slug = 'fix-bug';
    const result = await service.createWorktree(repoA, 'main', sessionId, slug);

    expect(result.branch).toBe('nuncio/abc12345-fix-bug');
    expect(result.worktreePath).toBe(join(workspacesDir, sessionId));

    const proc = Bun.spawn(['git', '-C', result.worktreePath, 'rev-parse', '--abbrev-ref', 'HEAD'], {
      stdout: 'pipe',
    });
    const branch = (await new Response(proc.stdout).text()).trim();
    expect(branch).toBe('nuncio/abc12345-fix-bug');

    await service.removeWorktree(repoA, result.worktreePath);
  });

  it('createWorktree sanitizes slug characters', async () => {
    const sessionId = 'def67890';
    const result = await service.createWorktree(repoB, 'develop', sessionId, 'Add Rate!!! Limiting');
    expect(result.branch).toBe('nuncio/def67890-add-rate-limiting');
    await service.removeWorktree(repoB, result.worktreePath);
  });

  it('createWorktree rejects non-git project paths', async () => {
    const notRepo = mkdtempSync(join(tmpdir(), 'not-git-wt-'));
    try {
      await expect(
        service.createWorktree(notRepo, 'main', 'bad00001', 'slug'),
      ).rejects.toBeInstanceOf(BadRequestException);
    } finally {
      rmSync(notRepo, { recursive: true, force: true });
    }
  });

  it('resolveRepoRoot returns top-level path for nested directories', async () => {
    const subdir = join(repoA, 'packages', 'core');
    mkdirSync(subdir, { recursive: true });
    const root = await service.resolveRepoRoot(subdir);
    expect(root).toBe(realpathSync.native(repoA));
  });

  it('createWorktree resolves the repo default branch when baseBranch is omitted', async () => {
    const developRepo = mkdtempSync(join(tmpdir(), 'nuncio-develop-repo-'));
    const developWs = mkdtempSync(join(tmpdir(), 'nuncio-develop-ws-'));
    const previousWorkspaces = process.env.NUNCIO_WORKSPACES_DIR;
    process.env.NUNCIO_WORKSPACES_DIR = developWs;
    try {
      await initRepo(developRepo, 'develop');

      const result = await service.createWorktree(developRepo, undefined, 'dev00001', 'task');

      const proc = Bun.spawn(
        ['git', '-C', result.worktreePath, 'log', '--format=%H', '-n', '1', 'develop'],
        { stdout: 'pipe', stderr: 'pipe' },
      );
      const code = await proc.exited;
      expect(code).toBe(0);
      await service.removeWorktree(developRepo, result.worktreePath);
    } finally {
      process.env.NUNCIO_WORKSPACES_DIR = previousWorkspaces;
      rmSync(developRepo, { recursive: true, force: true });
      rmSync(developWs, { recursive: true, force: true });
    }
  });
});
