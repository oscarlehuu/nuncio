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
  describe('Phase 1 — status / diff / stage / commit / push', () => {
    let repo: string;

    beforeEach(async () => {
      repo = mkdtempSync(join(tmpdir(), 'nuncio-status-repo-'));
      await initRepo(repo);
    });

    afterEach(() => {
      rmSync(repo, { recursive: true, force: true });
    });

    it('status reports a clean tree with no file entries', async () => {
      const status = await service.status(repo);
      expect(status.branch).toBe('main');
      expect(status.clean).toBe(true);
      expect(status.files).toEqual([]);
    });

    it('status lists an untracked file with the correct staged flag', async () => {
      writeFileSync(join(repo, 'new.txt'), 'hello\n');
      const status = await service.status(repo);
      expect(status.clean).toBe(false);
      const entry = status.files.find((f) => f.path === 'new.txt');
      expect(entry).toBeDefined();
      // Untracked → index column is '?', so not staged.
      expect(entry?.staged).toBe(false);
    });

    it('status marks a git-added file as staged', async () => {
      writeFileSync(join(repo, 'staged.txt'), 'content\n');
      await runGitAsync(repo, ['add', 'staged.txt']);
      const status = await service.status(repo);
      const entry = status.files.find((f) => f.path === 'staged.txt');
      expect(entry).toBeDefined();
      expect(entry?.staged).toBe(true);
    });

    it('diff returns the changed filename and hunk for unstaged work', async () => {
      writeFileSync(join(repo, 'README.md'), '# test\nchanged line\n');
      const result = await service.diff(repo);
      expect(result.diff).toContain('README.md');
      expect(result.diff).toContain('changed line');
      expect(result.truncated).toBe(false);
    });

    it('diff with staged option returns staged changes only', async () => {
      writeFileSync(join(repo, 'README.md'), '# test\nstaged change\n');
      await runGitAsync(repo, ['add', 'README.md']);
      const result = await service.diff(repo, { staged: true });
      expect(result.diff).toContain('staged change');
    });

    it('stageAll + commit produces a 40-char sha and clears the tree', async () => {
      writeFileSync(join(repo, 'feature.txt'), 'work\n');
      await service.stageAll(repo);
      const commit = await service.commit(repo, 'add feature');
      expect(commit.committed).toBe(true);
      expect(commit.sha).toMatch(/^[0-9a-f]{40}$/);

      const status = await service.status(repo);
      expect(status.clean).toBe(true);
      expect(status.files).toEqual([]);
    });

    it('push to a bare local remote reports pushed + remoteBranch and lands the branch', async () => {
      const bare = mkdtempSync(join(tmpdir(), 'nuncio-bare-'));
      try {
        await runGitAsync(bare, ['init', '--bare']);
        await runGitAsync(repo, ['remote', 'add', 'origin', bare]);

        const result = await service.push(repo, 'main');
        expect(result.pushed).toBe(true);
        expect(result.remoteBranch).toBe('main');

        const proc = Bun.spawn(['git', '-C', bare, 'rev-parse', '--verify', 'main'], {
          stdout: 'pipe',
          stderr: 'pipe',
        });
        const code = await proc.exited;
        expect(code).toBe(0);
      } finally {
        rmSync(bare, { recursive: true, force: true });
      }
    });

    it('force push uses --force-with-lease and succeeds after diverging history', async () => {
      const bare = mkdtempSync(join(tmpdir(), 'nuncio-bare-force-'));
      try {
        await runGitAsync(bare, ['init', '--bare']);
        await runGitAsync(repo, ['remote', 'add', 'origin', bare]);
        await service.push(repo, 'main');

        // Diverge local history with an amended commit so a plain push would be rejected.
        writeFileSync(join(repo, 'README.md'), '# test\namended\n');
        await runGitAsync(repo, ['add', 'README.md']);
        await runGitAsync(repo, ['commit', '--amend', '-m', 'amended init']);

        const result = await service.push(repo, 'main', { force: true });
        expect(result.pushed).toBe(true);
        expect(result.remoteBranch).toBe('main');

        const proc = Bun.spawn(['git', '-C', repo, 'rev-parse', 'main'], {
          stdout: 'pipe',
          stderr: 'pipe',
        });
        await proc.exited;
        const localSha = (await new Response(proc.stdout).text()).trim();
        const remoteProc = Bun.spawn(['git', '-C', bare, 'rev-parse', 'main'], {
          stdout: 'pipe',
          stderr: 'pipe',
        });
        await remoteProc.exited;
        const remoteSha = (await new Response(remoteProc.stdout).text()).trim();
        expect(remoteSha).toBe(localSha);
      } finally {
        rmSync(bare, { recursive: true, force: true });
      }
    });
  });

  describe('Phase 3 — remoteInfo', () => {
    let repo: string;

    beforeEach(async () => {
      repo = mkdtempSync(join(tmpdir(), 'nuncio-remote-repo-'));
      await initRepo(repo);
    });

    afterEach(() => {
      rmSync(repo, { recursive: true, force: true });
    });

    it('parses an ssh origin (git@github.com:owner/repo.git)', async () => {
      await runGitAsync(repo, ['remote', 'add', 'origin', 'git@github.com:octo/nuncio.git']);
      const info = await service.remoteInfo(repo);
      expect(info).toEqual({ host: 'github.com', owner: 'octo', repo: 'nuncio' });
    });

    it('parses an https origin and strips the .git suffix', async () => {
      await runGitAsync(repo, ['remote', 'add', 'origin', 'https://github.com/octo/nuncio.git']);
      const info = await service.remoteInfo(repo);
      expect(info).toEqual({ host: 'github.com', owner: 'octo', repo: 'nuncio' });
    });

    it('parses an https origin without a .git suffix', async () => {
      await runGitAsync(repo, ['remote', 'add', 'origin', 'https://github.com/octo/nuncio']);
      const info = await service.remoteInfo(repo);
      expect(info).toEqual({ host: 'github.com', owner: 'octo', repo: 'nuncio' });
    });
  });
});
