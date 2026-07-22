import { BadRequestException } from '@nestjs/common';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { GitService } from '../../../src/git/git.service';

async function runGitAsync(cwd: string, args: string[]): Promise<void> {
  const proc = Bun.spawn(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  const code = await proc.exited;
  if (code !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`git ${args.join(' ')} failed: ${stderr}`);
  }
}

async function readGitAsync(cwd: string, args: string[]): Promise<string> {
  const proc = Bun.spawn(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  const code = await proc.exited;
  const stdout = (await new Response(proc.stdout).text()).trim();
  if (code !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`git ${args.join(' ')} failed: ${stderr}`);
  }
  return stdout;
}

async function initRepo(
  dir: string,
  branch = 'main',
  objectFormat: 'sha1' | 'sha256' = 'sha1',
): Promise<void> {
  mkdirSync(dir, { recursive: true });
  await runGitAsync(dir, [
    'init', '-b', branch,
    ...(objectFormat === 'sha256' ? ['--object-format=sha256'] : []),
  ]);
  writeFileSync(join(dir, 'README.md'), '# test\n');
  await runGitAsync(dir, ['add', 'README.md']);
  await runGitAsync(dir, ['config', 'user.email', 'test@nuncio.local']);
  await runGitAsync(dir, ['config', 'user.name', 'Nuncio Test']);
  await runGitAsync(dir, ['commit', '-m', 'init']);
}

describe('GitService', () => {
  let service: GitService;
  let rootsDir: string;
  let workspacesDir: string;
  let repoA: string;
  let repoB: string;
  let nestedRepo: string;

  beforeAll(async () => {
    rootsDir = mkdtempSync(join(tmpdir(), 'nuncio-roots-'));
    workspacesDir = mkdtempSync(join(tmpdir(), 'nuncio-ws-'));
    process.env.NUNCIO_PROJECT_ROOTS = rootsDir;
    process.env.NUNCIO_WORKSPACES_DIR = workspacesDir;

    repoA = join(rootsDir, 'project-a');
    repoB = join(rootsDir, 'project-b');
    nestedRepo = join(rootsDir, 'nested', 'inner-repo');

    await initRepo(repoA);
    await initRepo(repoB, 'develop');
    mkdirSync(join(rootsDir, 'nested'), { recursive: true });
    await initRepo(nestedRepo);

    service = new GitService({
      resolve: (key: string) => process.env[key],
    } as never);
  });

  afterAll(async () => {
    rmSync(rootsDir, { recursive: true, force: true });
    rmSync(workspacesDir, { recursive: true, force: true });
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

  it('listBranches includes qualified remote-only refs without exposing remote HEAD', async () => {
    const head = await readGitAsync(repoA, ['rev-parse', 'HEAD']);
    await runGitAsync(repoA, ['update-ref', 'refs/remotes/origin/main', head]);
    await runGitAsync(repoA, ['update-ref', 'refs/remotes/origin/feature/remote', head]);
    await runGitAsync(repoA, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main']);

    const branches = await service.listBranches(repoA);

    expect(branches.map((branch) => branch.name)).toEqual([
      'main',
      'origin/feature/remote',
    ]);
    expect(branches.some((branch) => branch.name === 'origin/HEAD')).toBe(false);
    expect(branches.find((branch) => branch.name === 'main')).toMatchObject({
      isCurrent: true,
      isDefault: true,
    });
  });

  it('listBranches marks the symbolic default for a non-origin remote', async () => {
    const repo = join(rootsDir, 'remote-default', 'project');
    await initRepo(repo);
    const head = await readGitAsync(repo, ['rev-parse', 'HEAD']);
    await runGitAsync(repo, ['update-ref', 'refs/remotes/upstream/feature', head]);
    await runGitAsync(repo, ['update-ref', 'refs/remotes/upstream/main', head]);
    await runGitAsync(repo, ['symbolic-ref', 'refs/remotes/upstream/HEAD', 'refs/remotes/upstream/main']);
    await runGitAsync(repo, ['checkout', '--detach', head]);
    await runGitAsync(repo, ['branch', '-D', 'main']);

    const branches = await service.listBranches(repo);

    expect(branches.map((branch) => branch.name)).toEqual([
      'upstream/feature',
      'upstream/main',
    ]);
    expect(branches.find((branch) => branch.name === 'upstream/main')).toMatchObject({
      isCurrent: false,
      isDefault: true,
    });
    expect(branches.find((branch) => branch.name === 'upstream/feature')?.isDefault).toBe(false);
  });

  it('listBranches keeps a remote tracking ref when it diverges from its local branch', async () => {
    const repo = join(rootsDir, 'divergent-remote', 'project');
    await initRepo(repo);
    await runGitAsync(repo, ['checkout', '-b', 'remote-newer']);
    writeFileSync(join(repo, 'remote.txt'), 'newer remote commit\n');
    await runGitAsync(repo, ['add', 'remote.txt']);
    await runGitAsync(repo, ['commit', '-m', 'remote advances']);
    const remoteHead = await readGitAsync(repo, ['rev-parse', 'HEAD']);
    await runGitAsync(repo, ['checkout', 'main']);
    await runGitAsync(repo, ['branch', '-D', 'remote-newer']);
    await runGitAsync(repo, ['update-ref', 'refs/remotes/origin/main', remoteHead]);
    await runGitAsync(repo, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main']);

    const branches = await service.listBranches(repo);

    expect(branches.map((branch) => branch.name)).toEqual(['main', 'origin/main']);
  });

  it('listBranches resolves subdir to repo root via rev-parse', async () => {
    const subdir = join(repoA, 'src');
    mkdirSync(subdir, { recursive: true });
    const branches = await service.listBranches(subdir);
    expect(branches.some((b) => b.name === 'main')).toBe(true);
  });

  it('currentBranch resolves the checked out branch from a nested workspace path', async () => {
    const subdir = join(repoA, 'packages', 'server');
    mkdirSync(subdir, { recursive: true });

    await expect(service.currentBranch(subdir)).resolves.toBe('main');
  });

  it('currentBranch returns null for detached HEAD and non-git paths', async () => {
    const detachedRepo = mkdtempSync(join(tmpdir(), 'nuncio-detached-repo-'));
    const notRepo = mkdtempSync(join(tmpdir(), 'nuncio-current-branch-not-git-'));
    try {
      await initRepo(detachedRepo);
      await runGitAsync(detachedRepo, ['checkout', '--detach', 'HEAD']);

      await expect(service.currentBranch(detachedRepo)).resolves.toBeNull();
      await expect(service.currentBranch(notRepo)).resolves.toBeNull();
    } finally {
      rmSync(detachedRepo, { recursive: true, force: true });
      rmSync(notRepo, { recursive: true, force: true });
    }
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

  it('listBranches refresh fetches remote-only branches into the picker list', async () => {
    const origin = mkdtempSync(join(tmpdir(), 'nuncio-branch-refresh-origin-'));
    const clone = mkdtempSync(join(tmpdir(), 'nuncio-branch-refresh-clone-'));
    try {
      await runGitAsync(origin, ['init', '--bare']);
      await initRepo(clone);
      await runGitAsync(clone, ['remote', 'add', 'origin', origin]);
      await runGitAsync(clone, ['push', '-u', 'origin', 'main']);
      await runGitAsync(clone, ['checkout', '-b', 'feat/only-on-remote']);
      await runGitAsync(clone, ['commit', '--allow-empty', '-m', 'remote only']);
      await runGitAsync(clone, ['push', 'origin', 'feat/only-on-remote']);
      await runGitAsync(clone, ['checkout', 'main']);
      await runGitAsync(clone, ['branch', '-D', 'feat/only-on-remote']);
      // Push updates remote-tracking refs; drop them so refresh must re-fetch.
      await runGitAsync(clone, ['update-ref', '-d', 'refs/remotes/origin/feat/only-on-remote']);

      const stale = await service.listBranches(clone);
      expect(stale.some((b) => b.name === 'origin/feat/only-on-remote')).toBe(false);

      const refreshed = await service.listBranches(clone, { refresh: true });
      expect(refreshed.some((b) => b.name === 'origin/feat/only-on-remote')).toBe(true);
    } finally {
      rmSync(origin, { recursive: true, force: true });
      rmSync(clone, { recursive: true, force: true });
    }
  });

  it('listBranches refresh fails soft when origin is unreachable', async () => {
    const clone = mkdtempSync(join(tmpdir(), 'nuncio-branch-refresh-fail-'));
    try {
      await initRepo(clone);
      await runGitAsync(clone, [
        'remote', 'add', 'origin', 'file:///tmp/nuncio-missing-origin-does-not-exist',
      ]);

      const branches = await service.listBranches(clone, { refresh: true });
      expect(branches.some((b) => b.name === 'main')).toBe(true);
    } finally {
      rmSync(clone, { recursive: true, force: true });
    }
  });

  it('listBranches refresh respects a per-repo TTL between fetches', async () => {
    const origin = mkdtempSync(join(tmpdir(), 'nuncio-branch-ttl-origin-'));
    const clone = mkdtempSync(join(tmpdir(), 'nuncio-branch-ttl-clone-'));
    try {
      await runGitAsync(origin, ['init', '--bare']);
      await initRepo(clone);
      await runGitAsync(clone, ['remote', 'add', 'origin', origin]);
      await runGitAsync(clone, ['push', '-u', 'origin', 'main']);

      const t0 = 1_700_000_000_000;
      await service.listBranches(clone, { refresh: true, now: t0 });

      await runGitAsync(clone, ['checkout', '-b', 'feat/after-ttl']);
      await runGitAsync(clone, ['commit', '--allow-empty', '-m', 'after first fetch']);
      await runGitAsync(clone, ['push', 'origin', 'feat/after-ttl']);
      await runGitAsync(clone, ['checkout', 'main']);
      await runGitAsync(clone, ['branch', '-D', 'feat/after-ttl']);
      await runGitAsync(clone, ['update-ref', '-d', 'refs/remotes/origin/feat/after-ttl']);

      const withinTtl = await service.listBranches(clone, { refresh: true, now: t0 + 1_000 });
      expect(withinTtl.some((b) => b.name === 'origin/feat/after-ttl')).toBe(false);

      const afterTtl = await service.listBranches(clone, {
        refresh: true,
        now: t0 + 60_000 + 1,
      });
      expect(afterTtl.some((b) => b.name === 'origin/feat/after-ttl')).toBe(true);
    } finally {
      rmSync(origin, { recursive: true, force: true });
      rmSync(clone, { recursive: true, force: true });
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

      expect(result.baseBranch).toBe('develop');
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

  it('creates the generated branch at the exact remote-only base commit', async () => {
    await runGitAsync(repoA, ['checkout', '-b', 'temporary-pr-head']);
    await runGitAsync(repoA, ['commit', '--allow-empty', '-m', 'remote PR head']);
    const expectedHead = await readGitAsync(repoA, ['rev-parse', 'HEAD']);
    await runGitAsync(repoA, ['checkout', 'main']);
    await runGitAsync(repoA, ['update-ref', 'refs/remotes/origin/feat/pr-head', expectedHead]);
    await runGitAsync(repoA, ['branch', '-D', 'temporary-pr-head']);

    const result = await service.createWorktree(repoA, 'feat/pr-head', 'remote01', 'pr-head');
    try {
      expect(await readGitAsync(result.worktreePath, ['branch', '--show-current']))
        .toBe('nuncio/remote01-pr-head');
      expect(await readGitAsync(result.worktreePath, ['rev-parse', 'HEAD'])).toBe(expectedHead);
    } finally {
      await service.removeWorktree(repoA, result.worktreePath);
    }
  });

  it('fetches a GitHub pull-request head into an exact local ref', async () => {
    const origin = mkdtempSync(join(tmpdir(), 'nuncio-pr-origin-'));
    const source = mkdtempSync(join(tmpdir(), 'nuncio-pr-source-'));
    try {
      await runGitAsync(origin, ['init', '--bare']);
      await initRepo(source);
      await runGitAsync(source, ['remote', 'add', 'origin', origin]);
      await runGitAsync(source, ['checkout', '-b', 'feat/pull-head']);
      await runGitAsync(source, ['commit', '--allow-empty', '-m', 'pull head']);
      const expectedHead = await readGitAsync(source, ['rev-parse', 'HEAD']);
      await runGitAsync(source, ['push', 'origin', 'HEAD:refs/pull/42/head']);

      const ref = await service.fetchPullRequestHead(source, 'github', 42);

      expect(ref).toBe('refs/nuncio/pull-requests/github/42');
      expect(await readGitAsync(source, ['rev-parse', ref])).toBe(expectedHead);
    } finally {
      rmSync(origin, { recursive: true, force: true });
      rmSync(source, { recursive: true, force: true });
    }
  });

  it('tracks an adopted source branch and pulls later remote updates', async () => {
    const origin = mkdtempSync(join(tmpdir(), 'nuncio-upstream-origin-'));
    const source = mkdtempSync(join(tmpdir(), 'nuncio-upstream-source-'));
    try {
      await runGitAsync(origin, ['init', '--bare']);
      await initRepo(source);
      await runGitAsync(source, ['remote', 'add', 'origin', origin]);
      await runGitAsync(source, ['checkout', '-b', 'feat/pr-head']);
      await runGitAsync(source, ['commit', '--allow-empty', '-m', 'pull request head']);
      await runGitAsync(source, ['push', '-u', 'origin', 'feat/pr-head']);
      await runGitAsync(source, ['checkout', 'main']);

      const upstream = await service.fetchRemoteBranch(source, 'feat/pr-head');
      const worktree = await service.createWorktree(
        source,
        upstream,
        'upstream1',
        'adopted-pr',
      );
      try {
        await service.setWorktreeUpstream(worktree.worktreePath, worktree.branch, upstream);
        expect(await readGitAsync(worktree.worktreePath, [
          'rev-parse', '--abbrev-ref', '@{upstream}',
        ])).toBe('origin/feat/pr-head');
        expect(await readGitAsync(worktree.worktreePath, [
          'config', '--worktree', '--get', 'push.default',
        ])).toBe('upstream');

        await runGitAsync(worktree.worktreePath, ['commit', '--allow-empty', '-m', 'adopted update']);
        const adoptedHead = await readGitAsync(worktree.worktreePath, ['rev-parse', 'HEAD']);
        await runGitAsync(worktree.worktreePath, ['push']);
        expect(await readGitAsync(origin, ['rev-parse', 'refs/heads/feat/pr-head'])).toBe(adoptedHead);
        await expect(readGitAsync(origin, [
          'rev-parse', `refs/heads/${worktree.branch}`,
        ])).rejects.toThrow();

        await runGitAsync(source, ['checkout', 'feat/pr-head']);
        await runGitAsync(source, ['fetch', 'origin', 'feat/pr-head']);
        await runGitAsync(source, ['reset', '--hard', 'origin/feat/pr-head']);
        await runGitAsync(source, ['commit', '--allow-empty', '-m', 'remote update']);
        const remoteHead = await readGitAsync(source, ['rev-parse', 'HEAD']);
        await runGitAsync(source, ['push', 'origin', 'feat/pr-head']);
        await runGitAsync(source, ['checkout', 'main']);

        await service.pull(worktree.worktreePath);
        expect(await readGitAsync(worktree.worktreePath, ['rev-parse', 'HEAD'])).toBe(remoteHead);
      } finally {
        await service.removeWorktree(source, worktree.worktreePath);
      }
    } finally {
      rmSync(origin, { recursive: true, force: true });
      rmSync(source, { recursive: true, force: true });
    }
  });

  it('strict non-forced removal preserves a worktree that became dirty', async () => {
    const result = await service.createWorktree(repoA, 'main', 'dirty001', 'dirty');
    writeFileSync(join(result.worktreePath, 'untracked.txt'), 'keep me');

    await expect(service.removeWorktree(repoA, result.worktreePath, {
      force: false,
      bestEffort: false,
    })).rejects.toBeInstanceOf(BadRequestException);
    expect(existsSync(result.worktreePath)).toBe(true);

    await service.removeWorktree(repoA, result.worktreePath);
  });

  it('safe removal preserves a clean worktree with an unpushed commit', async () => {
    const result = await service.createWorktree(repoA, 'main', 'unpushed1', 'unpushed');
    await runGitAsync(result.worktreePath, ['commit', '--allow-empty', '-m', 'not pushed']);

    const removal = await service.removeWorktreeIfSafe(repoA, result.worktreePath, {
      fallbackBase: 'main',
    });

    expect(removal).toEqual({ removed: false, reason: 'unpushed-after-archive' });
    expect(existsSync(result.worktreePath)).toBe(true);
    await service.removeWorktree(repoA, result.worktreePath);
  });

  it('safe removal deletes a clean worktree while holding the head ref lock', async () => {
    const result = await service.createWorktree(repoA, 'main', 'safe0001', 'safe');

    expect(await service.removeWorktreeIfSafe(repoA, result.worktreePath, {
      fallbackBase: 'main',
    })).toEqual({ removed: true });
    expect(existsSync(result.worktreePath)).toBe(false);
  });

  it('reports a vanished worktree as a non-removal result', async () => {
    const result = await service.createWorktree(repoA, 'main', 'vanished1', 'vanished');
    rmSync(result.worktreePath, { recursive: true, force: true });
    mkdirSync(result.worktreePath, { recursive: true });

    await expect(service.removeWorktreeIfSafe(repoA, result.worktreePath, {
      fallbackBase: 'main',
    })).resolves.toEqual({ removed: false, reason: 'worktree-missing' });
    expect(existsSync(result.worktreePath)).toBe(true);
    rmSync(result.worktreePath, { recursive: true, force: true });
    await runGitAsync(repoA, ['worktree', 'prune']);
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

    it('hasChanges is false on a clean tree, true once a file is added (rung-3 empty-diff signal)', async () => {
      expect(await service.hasChanges(repo)).toBe(false);
      writeFileSync(join(repo, 'work.txt'), 'wip\n');
      expect(await service.hasChanges(repo)).toBe(true);
    });

    it('hasChanges returns false for a non-repo path (never throws)', async () => {
      const notARepo = mkdtempSync(join(tmpdir(), 'nuncio-not-a-repo-'));
      try {
        expect(await service.hasChanges(notARepo)).toBe(false);
      } finally {
        rmSync(notARepo, { recursive: true, force: true });
      }
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

    it('status populates insertions/deletions for a modified tracked file', async () => {
      writeFileSync(join(repo, 'README.md'), '# test\nchanged line\nanother line\n');
      const status = await service.status(repo);
      const entry = status.files.find((f) => f.path === 'README.md');
      expect(entry).toBeDefined();
      expect(entry?.insertions).toBeGreaterThan(0);
      expect(entry?.deletions).toBe(0);
    });

    it('status counts an untracked file line total as insertions', async () => {
      writeFileSync(join(repo, 'new.txt'), 'one\ntwo\nthree');
      const status = await service.status(repo);
      const entry = status.files.find((f) => f.path === 'new.txt');
      expect(entry).toBeDefined();
      expect(entry?.insertions).toBe(3);
      expect(entry?.deletions).toBe(0);
    });

    it('status does not throw while counting an untracked directory entry', async () => {
      mkdirSync(join(repo, 'new-dir'), { recursive: true });
      writeFileSync(join(repo, 'new-dir', 'child.txt'), 'nested\n');
      const status = await service.status(repo);
      const entry = status.files.find((f) => f.path === 'new-dir/');
      expect(entry).toBeDefined();
      expect(entry?.insertions).toBe(0);
      expect(entry?.deletions).toBe(0);
    });

    it('status still returns stats for untracked files on an unborn branch', async () => {
      const unbornRepo = mkdtempSync(join(tmpdir(), 'nuncio-unborn-repo-'));
      try {
        await runGitAsync(unbornRepo, ['init', '-b', 'main']);
        writeFileSync(join(unbornRepo, 'fresh.txt'), 'alpha\nbeta\n');
        const status = await service.status(unbornRepo);
        const entry = status.files.find((f) => f.path === 'fresh.txt');
        expect(entry).toBeDefined();
        expect(entry?.insertions).toBe(2);
        expect(entry?.deletions).toBe(0);
      } finally {
        rmSync(unbornRepo, { recursive: true, force: true });
      }
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

    it('diff with a path returns only that tracked file diff', async () => {
      writeFileSync(join(repo, 'README.md'), '# test\nreadme change\n');
      writeFileSync(join(repo, 'other.txt'), 'other change\n');
      await runGitAsync(repo, ['add', 'other.txt']);
      await runGitAsync(repo, ['commit', '-m', 'add other']);
      writeFileSync(join(repo, 'other.txt'), 'other change\nsecond change\n');

      const result = await service.diff(repo, { path: 'README.md' });
      expect(result.diff).toContain('README.md');
      expect(result.diff).toContain('readme change');
      expect(result.diff).not.toContain('other.txt');
      expect(result.diff).not.toContain('second change');
    });

    it('diff with a path returns an add-style diff for an untracked file', async () => {
      writeFileSync(join(repo, 'new.txt'), 'hello\nworld\n');
      const result = await service.diff(repo, { path: 'new.txt' });
      expect(result.diff).toContain('new.txt');
      expect(result.diff).toContain('+hello');
      expect(result.diff).toContain('+world');
    });

    it('diff with a path rejects unsafe path values', async () => {
      await expect(service.diff(repo, { path: '../etc/passwd' })).rejects.toBeInstanceOf(BadRequestException);
      await expect(service.diff(repo, { path: '-c/core.sshCommand=touch hacked' })).rejects.toBeInstanceOf(BadRequestException);
      await expect(service.diff(repo, { path: '/etc/passwd' })).rejects.toBeInstanceOf(BadRequestException);
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

    it('unpushedCommits lists commits ahead of the configured upstream', async () => {
      const bare = mkdtempSync(join(tmpdir(), 'nuncio-bare-unpushed-'));
      try {
        await runGitAsync(bare, ['init', '--bare']);
        await runGitAsync(repo, ['remote', 'add', 'origin', bare]);
        await service.push(repo, 'main');
        await runGitAsync(repo, ['branch', '--set-upstream-to=origin/main', 'main']);

        writeFileSync(join(repo, 'ahead.txt'), 'local only\n');
        await runGitAsync(repo, ['add', 'ahead.txt']);
        await runGitAsync(repo, ['commit', '-m', 'local commit one']);
        writeFileSync(join(repo, 'ahead2.txt'), 'local two\n');
        await runGitAsync(repo, ['add', 'ahead2.txt']);
        await runGitAsync(repo, ['commit', '-m', 'local commit two']);

        const result = await service.unpushedCommits(repo);
        expect(result.branch).toBe('main');
        expect(result.base).toBe('origin/main');
        expect(result.commits.map((c) => c.subject)).toEqual([
          'local commit two',
          'local commit one',
        ]);
        expect(result.commits[0]?.sha).toMatch(/^[0-9a-f]{40}$/);
        expect(result.commits[0]?.shortSha).toMatch(/^[0-9a-f]{7,}$/);
        expect(result.commits[0]?.authorName).toBe('Nuncio Test');
        expect(result.commits[0]?.authoredAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      } finally {
        rmSync(bare, { recursive: true, force: true });
      }
    });

    it('unpushedCommits falls back to origin/<branch> when upstream is unset', async () => {
      const bare = mkdtempSync(join(tmpdir(), 'nuncio-bare-origin-fallback-'));
      try {
        await runGitAsync(bare, ['init', '--bare']);
        await runGitAsync(repo, ['remote', 'add', 'origin', bare]);
        await service.push(repo, 'main');
        // No upstream configured — still compare against origin/main.

        writeFileSync(join(repo, 'solo.txt'), 'solo\n');
        await runGitAsync(repo, ['add', 'solo.txt']);
        await runGitAsync(repo, ['commit', '-m', 'solo ahead']);

        const result = await service.unpushedCommits(repo);
        expect(result.base).toBe('origin/main');
        expect(result.commits.map((c) => c.subject)).toEqual(['solo ahead']);
      } finally {
        rmSync(bare, { recursive: true, force: true });
      }
    });

    it('unpushedCommits uses fallbackBase when the branch has never been pushed', async () => {
      await runGitAsync(repo, ['checkout', '-b', 'feature/never-pushed']);
      writeFileSync(join(repo, 'feat.txt'), 'feature\n');
      await runGitAsync(repo, ['add', 'feat.txt']);
      await runGitAsync(repo, ['commit', '-m', 'feature work']);

      const result = await service.unpushedCommits(repo, { fallbackBase: 'main' });
      expect(result.branch).toBe('feature/never-pushed');
      expect(result.base).toBe('main');
      expect(result.commits.map((c) => c.subject)).toEqual(['feature work']);
    });

    it('unpushedCommits returns an empty list when fully synced with upstream', async () => {
      const bare = mkdtempSync(join(tmpdir(), 'nuncio-bare-synced-'));
      try {
        await runGitAsync(bare, ['init', '--bare']);
        await runGitAsync(repo, ['remote', 'add', 'origin', bare]);
        await service.push(repo, 'main');
        await runGitAsync(repo, ['branch', '--set-upstream-to=origin/main', 'main']);

        const result = await service.unpushedCommits(repo);
        expect(result.commits).toEqual([]);
        expect(result.base).toBe('origin/main');
      } finally {
        rmSync(bare, { recursive: true, force: true });
      }
    });

    it('branchSync reports outgoing and incoming commits', async () => {
      const bare = mkdtempSync(join(tmpdir(), 'nuncio-scm-bare-'));
      try {
        await runGitAsync(bare, ['init', '--bare']);
        await runGitAsync(repo, ['remote', 'add', 'origin', bare]);
        await service.push(repo, 'main');
        await runGitAsync(bare, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
        await runGitAsync(repo, ['branch', '--set-upstream-to=origin/main', 'main']);

        writeFileSync(join(repo, 'local.txt'), 'local\n');
        await runGitAsync(repo, ['add', 'local.txt']);
        await runGitAsync(repo, ['commit', '-m', 'local outgoing']);

        const remoteClone = mkdtempSync(join(tmpdir(), 'nuncio-scm-remote-clone-'));
        try {
          await runGitAsync(remoteClone, ['clone', '-b', 'main', bare, '.']);
          await runGitAsync(remoteClone, ['config', 'user.email', 'remote@nuncio.local']);
          await runGitAsync(remoteClone, ['config', 'user.name', 'Remote']);
          writeFileSync(join(remoteClone, 'remote.txt'), 'remote\n');
          await runGitAsync(remoteClone, ['add', 'remote.txt']);
          await runGitAsync(remoteClone, ['commit', '-m', 'remote incoming']);
          await runGitAsync(remoteClone, ['push', 'origin', 'main']);
        } finally {
          rmSync(remoteClone, { recursive: true, force: true });
        }

        await runGitAsync(repo, ['fetch', 'origin']);

        const sync = await service.branchSync(repo);
        expect(sync.branch).toBe('main');
        expect(sync.base).toBe('origin/main');
        expect(sync.ahead).toBe(1);
        expect(sync.behind).toBe(1);
        expect(sync.outgoing.map((c) => c.subject)).toEqual(['local outgoing']);
        expect(sync.incoming.map((c) => c.subject)).toEqual(['remote incoming']);
        expect(sync.clean).toBe(true);
        expect(sync.conflicts).toEqual([]);
      } finally {
        rmSync(bare, { recursive: true, force: true });
      }
    });

    it('commitDiff returns the commit patch', async () => {
      writeFileSync(join(repo, 'diff.txt'), 'patch me\n');
      await runGitAsync(repo, ['add', 'diff.txt']);
      await runGitAsync(repo, ['commit', '-m', 'add diff file']);
      const sha = await readGitAsync(repo, ['rev-parse', 'HEAD']);

      const result = await service.commitDiff(repo, sha);
      expect(result.diff).toContain('diff.txt');
      expect(result.diff).toContain('patch me');
      expect(result.truncated).toBe(false);
    });

    it('stashList returns entries after stashing', async () => {
      writeFileSync(join(repo, 'README.md'), '# test\nstashed\n');
      await runGitAsync(repo, ['stash', 'push', '-m', 'wip changes']);

      const entries = await service.stashList(repo);
      expect(entries.length).toBe(1);
      expect(entries[0]?.index).toBe(0);
      expect(entries[0]?.message).toContain('wip changes');
      expect(entries[0]?.sha).toMatch(/^[0-9a-f]{40}$/);
    });

    it('blame returns per-line attribution', async () => {
      const result = await service.blame(repo, 'README.md');
      expect(result.path).toBe('README.md');
      expect(result.lines.length).toBeGreaterThan(0);
      expect(result.lines[0]?.content).toBeTruthy();
      expect(result.lines[0]?.sha).toMatch(/^[0-9a-f]{40}$/);
      expect(result.lines[0]?.shortSha).toMatch(/^[0-9a-f]{7}$/);
      expect(result.truncated).toBe(false);
    });

    it('history includes parent short shas', async () => {
      writeFileSync(join(repo, 'second.txt'), 'two\n');
      await runGitAsync(repo, ['add', 'second.txt']);
      await runGitAsync(repo, ['commit', '-m', 'second commit']);

      const result = await service.history(repo, { limit: 5 });
      expect(result.branch).toBe('main');
      expect(result.commits.length).toBe(2);
      expect(result.commits[0]?.subject).toBe('second commit');
      expect(result.commits[0]?.parents.length).toBe(1);
      expect(result.commits[0]?.parents[0]).toMatch(/^[0-9a-f]{7}$/);
      expect(result.commits[1]?.parents).toEqual([]);
    });

    it('history can list commits for a non-HEAD branch', async () => {
      await runGitAsync(repo, ['checkout', '-b', 'feat/history-view']);
      writeFileSync(join(repo, 'feature.txt'), 'feature work\n');
      await runGitAsync(repo, ['add', 'feature.txt']);
      await runGitAsync(repo, ['commit', '-m', 'feat: history on feature']);
      await runGitAsync(repo, ['checkout', 'main']);

      const onFeature = await service.history(repo, { branch: 'feat/history-view', limit: 5 });
      expect(onFeature.branch).toBe('feat/history-view');
      expect(onFeature.commits[0]?.subject).toBe('feat: history on feature');

      const onMain = await service.history(repo, { branch: 'main', limit: 5 });
      expect(onMain.branch).toBe('main');
      expect(onMain.commits.map((c) => c.subject)).not.toContain('feat: history on feature');
    });

    it('history rejects an unknown branch ref', async () => {
      await expect(service.history(repo, { branch: 'does-not-exist' })).rejects.toBeInstanceOf(
        BadRequestException,
      );
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

    it('pushes a local worktree branch to a different PR source branch', async () => {
      const bare = mkdtempSync(join(tmpdir(), 'nuncio-bare-pr-'));
      try {
        await runGitAsync(bare, ['init', '--bare']);
        await runGitAsync(repo, ['remote', 'add', 'origin', bare]);

        const result = await service.push(repo, 'main', { remoteBranch: 'feat/pr-head' });

        expect(result).toEqual({ pushed: true, remoteBranch: 'feat/pr-head' });
        expect(await readGitAsync(bare, ['rev-parse', 'refs/heads/feat/pr-head']))
          .toBe(await readGitAsync(repo, ['rev-parse', 'main']));
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

    it('preserves nested GitLab namespaces for ssh and https origins', async () => {
      await runGitAsync(repo, [
        'remote', 'add', 'origin', 'git@gitlab.com:group/subgroup/nuncio.git',
      ]);
      expect(await service.remoteInfo(repo)).toEqual({
        host: 'gitlab.com', owner: 'group/subgroup', repo: 'nuncio',
      });

      await runGitAsync(repo, [
        'remote', 'set-url', 'origin', 'https://gitlab.com/group/subgroup/nuncio.git',
      ]);
      expect(await service.remoteInfo(repo)).toEqual({
        host: 'gitlab.com', owner: 'group/subgroup', repo: 'nuncio',
      });
    });
  });

  describe('Workspace boundary and checkpoint', () => {
    let repo: string;

    beforeEach(async () => {
      repo = mkdtempSync(join(tmpdir(), 'nuncio-workspace-boundary-'));
      await initRepo(repo);
    });

    afterEach(() => {
      rmSync(repo, { recursive: true, force: true });
    });

    it('reports canonical path, branch, full HEAD, cleanliness, and ancestry', async () => {
      const initialHead = await readGitAsync(repo, ['rev-parse', 'HEAD']);
      writeFileSync(join(repo, 'next.txt'), 'next\n');
      await runGitAsync(repo, ['add', 'next.txt']);
      await runGitAsync(repo, ['commit', '-m', 'next']);

      const result = await service.inspectBoundary(repo, {
        expectedBranch: 'main',
        expectedAncestorHead: initialHead,
      });

      expect(result).toMatchObject({
        ok: true,
        exists: true,
        symlink: false,
        canonicalPath: realpathSync.native(repo),
        branch: 'main',
        clean: true,
        reachable: true,
        reason: null,
      });
      expect(result.fullHead).toMatch(/^[0-9a-f]{40}$/);
    });

    it('returns structured failures for missing, symlinked, and wrong-branch workspaces', async () => {
      const missing = await service.inspectBoundary(join(repo, 'missing'));
      expect(missing).toMatchObject({ ok: false, exists: false, reason: 'missing' });

      const link = `${repo}-link`;
      symlinkSync(repo, link, 'dir');
      try {
        const symlinked = await service.inspectBoundary(link);
        expect(symlinked).toMatchObject({ ok: false, exists: true, symlink: true, reason: 'symlink' });
      } finally {
        rmSync(link, { force: true });
      }

      const wrongBranch = await service.inspectBoundary(repo, 'develop');
      expect(wrongBranch).toMatchObject({
        ok: false,
        exists: true,
        branch: 'main',
        reason: 'branch-mismatch',
      });
    });

    it('rejects a workspace reached through a symlinked parent component', async () => {
      const linkedParent = `${repo}-parent-link`;
      symlinkSync(resolve(repo, '..'), linkedParent, 'dir');
      try {
        const result = await service.inspectBoundary(join(linkedParent, repo.split('/').at(-1)!));
        expect(result).toMatchObject({
          ok: false,
          exists: true,
          symlink: true,
          reason: 'symlink',
        });
      } finally {
        rmSync(linkedParent, { force: true });
      }
    });

    it('marks a workspace unreachable when HEAD diverges from the recorded ancestor', async () => {
      writeFileSync(join(repo, 'main-only.txt'), 'main\n');
      await runGitAsync(repo, ['add', 'main-only.txt']);
      await runGitAsync(repo, ['commit', '-m', 'main only']);
      const mainHead = await readGitAsync(repo, ['rev-parse', 'HEAD']);
      const rootHead = await readGitAsync(repo, ['rev-parse', 'HEAD^']);
      await runGitAsync(repo, ['checkout', '-b', 'side', rootHead]);
      writeFileSync(join(repo, 'side-only.txt'), 'side\n');
      await runGitAsync(repo, ['add', 'side-only.txt']);
      await runGitAsync(repo, ['commit', '-m', 'side only']);

      const result = await service.inspectBoundary(repo, { expectedAncestorHead: mainHead });
      expect(result).toMatchObject({
        ok: false,
        branch: 'side',
        reachable: false,
        reason: 'head-diverged',
      });
    });

    it('checkpoints dirty workspace changes with a deterministic local commit and full SHA', async () => {
      writeFileSync(join(repo, 'workspace-output.txt'), 'result\n');

      const checkpoint = await service.checkpoint(repo, 'checkpoint: committed output');

      expect(checkpoint).toMatchObject({ committed: true, clean: true });
      expect(checkpoint.fullHead).toMatch(/^[0-9a-f]{40}$/);
      expect(await readGitAsync(repo, ['show', '--format=%s', '--no-patch', 'HEAD']))
        .toBe('checkpoint: committed output');

      await expect(service.checkpoint(repo, 'unused clean checkpoint')).resolves.toEqual({
        fullHead: checkpoint.fullHead,
        clean: true,
        committed: false,
      });
    });

    it('rejects a sensitive path already committed in the workspace in the exact descendant range', async () => {
      const fromHead = await readGitAsync(repo, ['rev-parse', 'HEAD']);
      writeFileSync(join(repo, '.env'), 'DATABASE_PASSWORD=do-not-commit\n');
      await runGitAsync(repo, ['add', '.env']);
      await runGitAsync(repo, ['commit', '-m', 'workspace self-commit']);
      const toHead = await readGitAsync(repo, ['rev-parse', 'HEAD']);

      await expect(validateCheckpointRange(service, repo, fromHead, toHead))
        .rejects.toThrow('Sensitive paths');
    });

    it('rejects high-confidence secret content in an ordinary self-committed file', async () => {
      const fromHead = await readGitAsync(repo, ['rev-parse', 'HEAD']);
      const secret = `sk-proj-${'A1b2C3d4'.repeat(8)}`;
      writeFileSync(join(repo, 'src-config.ts'), `export const apiKey = '${secret}';\n`);
      await runGitAsync(repo, ['add', 'src-config.ts']);
      await runGitAsync(repo, ['commit', '-m', 'workspace source commit']);
      const toHead = await readGitAsync(repo, ['rev-parse', 'HEAD']);

      const message = await validateCheckpointRange(service, repo, fromHead, toHead).then(
        () => 'unexpected success',
        (error: unknown) => error instanceof Error ? error.message : String(error),
      );
      expect(message).toContain('Potential secret content');
      expect(message).toContain('src-config.ts');
      expect(message).not.toContain(secret);
    });

    it('rejects a high-confidence secret retained only in the direct workspace commit message', async () => {
      const fromHead = await readGitAsync(repo, ['rev-parse', 'HEAD']);
      const secret = `sk-proj-${'A1b2C3d4'.repeat(8)}`;
      writeFileSync(join(repo, 'safe-message-output.ts'), "export const result = 'safe';\n");
      await runGitAsync(repo, ['add', 'safe-message-output.ts']);
      await runGitAsync(repo, ['commit', '-m', `workspace note ${secret}`]);
      const toHead = await readGitAsync(repo, ['rev-parse', 'HEAD']);

      const message = await validateCheckpointRange(service, repo, fromHead, toHead).then(
        () => 'unexpected success',
        (error: unknown) => error instanceof Error ? error.message : String(error),
      );
      expect(message).toContain('Potential secret content');
      expect(message).toContain('commit message');
      expect(message).not.toContain(secret);
    });

    it('fails closed for a self-committed symlink or an oversized descendant blob', async () => {
      let fromHead = await readGitAsync(repo, ['rev-parse', 'HEAD']);
      symlinkSync('../outside-workspace', join(repo, 'linked-output'));
      await runGitAsync(repo, ['add', 'linked-output']);
      await runGitAsync(repo, ['commit', '-m', 'workspace symlink commit']);
      let toHead = await readGitAsync(repo, ['rev-parse', 'HEAD']);
      await expect(validateCheckpointRange(service, repo, fromHead, toHead))
        .rejects.toThrow('could not safely inspect');

      rmSync(join(repo, 'linked-output'));
      await runGitAsync(repo, ['add', 'linked-output']);
      await runGitAsync(repo, ['commit', '-m', 'remove symlink']);
      fromHead = await readGitAsync(repo, ['rev-parse', 'HEAD']);
      writeFileSync(join(repo, 'oversized-output.txt'), 'x'.repeat(1_048_577));
      await runGitAsync(repo, ['add', 'oversized-output.txt']);
      await runGitAsync(repo, ['commit', '-m', 'workspace oversized commit']);
      toHead = await readGitAsync(repo, ['rev-parse', 'HEAD']);
      await expect(validateCheckpointRange(service, repo, fromHead, toHead))
        .rejects.toThrow('could not safely inspect');
    });

    it('validates only a clean current descendant range and accepts bounded ordinary blobs', async () => {
      const fromHead = await readGitAsync(repo, ['rev-parse', 'HEAD']);
      writeFileSync(join(repo, 'safe-output.ts'), "export const status = 'green';\n");
      await runGitAsync(repo, ['add', 'safe-output.ts']);
      await runGitAsync(repo, ['commit', '-m', 'workspace safe commit']);
      const toHead = await readGitAsync(repo, ['rev-parse', 'HEAD']);

      await expect(validateCheckpointRange(service, repo, fromHead, toHead)).resolves.toBeUndefined();
      await expect(validateCheckpointRange(service, repo, fromHead, fromHead))
        .rejects.toThrow('boundary');
      writeFileSync(join(repo, 'dirty-after-head.txt'), 'not committed\n');
      await expect(validateCheckpointRange(service, repo, fromHead, toHead))
        .rejects.toThrow('boundary');
    });

    it('accepts a clean deletion-only descendant range with no final blobs to scan', async () => {
      const fromHead = await readGitAsync(repo, ['rev-parse', 'HEAD']);
      rmSync(join(repo, 'README.md'));
      await runGitAsync(repo, ['add', 'README.md']);
      await runGitAsync(repo, ['commit', '-m', 'workspace deletion commit']);
      const toHead = await readGitAsync(repo, ['rev-parse', 'HEAD']);

      await expect(validateCheckpointRange(service, repo, fromHead, toHead)).resolves.toBeUndefined();
    });

    it('rejects add-then-delete secrets retained in multi-commit workspace history', async () => {
      const fromHead = await readGitAsync(repo, ['rev-parse', 'HEAD']);
      const secret = `sk-proj-${'A1b2C3d4'.repeat(8)}`;
      writeFileSync(join(repo, 'temporary-secret.ts'), `export const token = '${secret}';\n`);
      await runGitAsync(repo, ['add', 'temporary-secret.ts']);
      await runGitAsync(repo, ['commit', '-m', 'workspace adds secret']);
      rmSync(join(repo, 'temporary-secret.ts'));
      await runGitAsync(repo, ['add', 'temporary-secret.ts']);
      await runGitAsync(repo, ['commit', '-m', 'workspace deletes secret']);
      const toHead = await readGitAsync(repo, ['rev-parse', 'HEAD']);

      await expect(validateCheckpointRange(service, repo, fromHead, toHead))
        .rejects.toThrow('single linear commit');
    });

    it('rejects nonlinear or merged workspace history instead of scanning only the final tree', async () => {
      const fromHead = await readGitAsync(repo, ['rev-parse', 'HEAD']);
      await runGitAsync(repo, ['checkout', '-b', 'workspace-side']);
      writeFileSync(join(repo, 'side.ts'), 'export const side = true;\n');
      await runGitAsync(repo, ['add', 'side.ts']);
      await runGitAsync(repo, ['commit', '-m', 'workspace side commit']);
      await runGitAsync(repo, ['checkout', 'main']);
      writeFileSync(join(repo, 'main.ts'), 'export const main = true;\n');
      await runGitAsync(repo, ['add', 'main.ts']);
      await runGitAsync(repo, ['commit', '-m', 'workspace main commit']);
      await runGitAsync(repo, ['merge', '--no-ff', 'workspace-side', '-m', 'workspace merge']);
      const toHead = await readGitAsync(repo, ['rev-parse', 'HEAD']);

      await expect(validateCheckpointRange(service, repo, fromHead, toHead))
        .rejects.toThrow('single linear commit');
    });

    it('validates the actual commit graph instead of a workspace-controlled replacement ref', async () => {
      const fromHead = await readGitAsync(repo, ['rev-parse', 'HEAD']);
      const secret = `sk-proj-${'A1b2C3d4'.repeat(8)}`;
      writeFileSync(join(repo, 'replaced-secret.ts'), `export const token = '${secret}';\n`);
      await runGitAsync(repo, ['add', 'replaced-secret.ts']);
      await runGitAsync(repo, ['commit', '-m', 'workspace secret commit']);
      rmSync(join(repo, 'replaced-secret.ts'));
      await runGitAsync(repo, ['add', 'replaced-secret.ts']);
      await runGitAsync(repo, ['commit', '-m', 'workspace delete commit']);
      const toHead = await readGitAsync(repo, ['rev-parse', 'HEAD']);
      const finalTree = await readGitAsync(repo, ['rev-parse', `${toHead}^{tree}`]);
      const replacement = await readGitAsync(repo, [
        'commit-tree', finalTree, '-p', fromHead, '-m', 'conceal workspace history',
      ]);
      await runGitAsync(repo, ['replace', toHead, replacement]);

      await expect(validateCheckpointRange(service, repo, fromHead, toHead))
        .rejects.toThrow('single linear commit');
    });

    it('validates a direct SHA-256 descendant with 64-character object ids', async () => {
      rmSync(repo, { recursive: true, force: true });
      await initRepo(repo, 'main', 'sha256');
      const fromHead = await readGitAsync(repo, ['rev-parse', 'HEAD']);
      writeFileSync(join(repo, 'safe-sha256.ts'), "export const result = 'safe';\n");
      await runGitAsync(repo, ['add', 'safe-sha256.ts']);
      await runGitAsync(repo, ['commit', '-m', 'workspace sha256 commit']);
      const toHead = await readGitAsync(repo, ['rev-parse', 'HEAD']);

      expect(fromHead).toHaveLength(64);
      expect(toHead).toHaveLength(64);
      await expect(validateCheckpointRange(service, repo, fromHead, toHead)).resolves.toBeUndefined();
    });

    it('refuses to commit without repository-local identity', async () => {
      await runGitAsync(repo, ['config', '--local', '--unset', 'user.name']);
      await runGitAsync(repo, ['config', '--local', '--unset', 'user.email']);
      writeFileSync(join(repo, 'unowned.txt'), 'no identity\n');

      await expect(service.checkpoint(repo, 'must fail')).rejects.toThrow('local Git identity');
      expect(await readGitAsync(repo, ['rev-list', '--count', 'HEAD'])).toBe('1');
    });

    it('fails closed before staging obvious sensitive files, including already-staged paths', async () => {
      writeFileSync(join(repo, '.env'), 'SECRET=do-not-commit\n');
      mkdirSync(join(repo, 'secrets'));
      writeFileSync(join(repo, 'secrets', 'private.pem'), 'private\n');

      await expect(service.checkpoint(repo, 'must reject secrets')).rejects.toThrow('Sensitive paths');
      expect(await readGitAsync(repo, ['diff', '--cached', '--name-only'])).toBe('');
      expect(await readGitAsync(repo, ['rev-list', '--count', 'HEAD'])).toBe('1');

      await runGitAsync(repo, ['add', '.env']);
      await expect(service.checkpoint(repo, 'must reject staged secret')).rejects.toThrow('Sensitive paths');
      expect(await readGitAsync(repo, ['rev-list', '--count', 'HEAD'])).toBe('1');
    });

    it('allows clearly documented sample credential filenames', async () => {
      writeFileSync(join(repo, '.env.example'), 'TOKEN=example\n');
      writeFileSync(join(repo, 'credentials.sample.json'), '{}\n');
      writeFileSync(join(repo, 'private-key.template.pem'), 'example\n');
      writeFileSync(join(repo, 'client.example.p12'), 'example\n');

      await expect(service.checkpoint(repo, 'add credential examples')).resolves.toMatchObject({
        committed: true,
        clean: true,
      });
    });

    it('rejects common secret containers and reports every blocked path', async () => {
      const paths = [
        '.envrc',
        '.npmrc',
        '.git-credentials',
        'client.p12',
        'client.pfx',
        'trust.jks',
        'signing.keystore',
      ];
      for (const path of paths) writeFileSync(join(repo, path), 'secret\n');

      const message = await service.checkpoint(repo, 'must reject containers').then(
        () => 'unexpected success',
        (error: unknown) => error instanceof Error ? error.message : String(error),
      );
      for (const path of paths) expect(message).toContain(path);
      expect(await readGitAsync(repo, ['diff', '--cached', '--name-only'])).toBe('');
    });

    it('rejects a secret added to an ordinary tracked source file without staging it', async () => {
      mkdirSync(join(repo, 'src'));
      writeFileSync(join(repo, 'src/config.ts'), "export const mode = 'safe';\n");
      await runGitAsync(repo, ['add', 'src/config.ts']);
      await runGitAsync(repo, ['commit', '-m', 'add config']);
      const secret = `sk-proj-${'A1b2C3d4'.repeat(8)}`;
      writeFileSync(join(repo, 'src/config.ts'), `export const apiKey = '${secret}';\n`);

      const message = await service.checkpoint(repo, 'must reject source secret').then(
        () => 'unexpected success',
        (error: unknown) => error instanceof Error ? error.message : String(error),
      );

      expect(message).toContain('Potential secret content');
      expect(message).toContain('src/config.ts');
      expect(message).not.toContain(secret);
      expect(await readGitAsync(repo, ['diff', '--cached', '--name-only'])).toBe('');
      expect(await readGitAsync(repo, ['rev-list', '--count', 'HEAD'])).toBe('2');
    });

    it('scans exact staged blobs before a clean filter can create checkpoint history', async () => {
      const secret = `sk-proj-${'A1b2C3d4'.repeat(8)}`;
      await runGitAsync(repo, ['config', 'filter.nuncio-secret.clean', `sed 's/SAFE/${secret}/g'`]);
      await runGitAsync(repo, ['config', 'filter.nuncio-secret.required', 'true']);
      writeFileSync(join(repo, '.gitattributes'), 'filtered.txt filter=nuncio-secret\n');
      writeFileSync(join(repo, 'filtered.txt'), 'SAFE\n');

      const message = await service.checkpoint(repo, 'must scan staged bytes').then(
        () => 'unexpected success',
        (error: unknown) => error instanceof Error ? error.message : String(error),
      );

      expect(message).toContain('Potential secret content');
      expect(message).toContain('filtered.txt');
      expect(message).not.toContain(secret);
      expect(await readGitAsync(repo, ['rev-list', '--count', 'HEAD'])).toBe('1');
      expect(await readGitAsync(repo, ['diff', '--cached', '--name-only'])).toBe('');
    });

    it('rejects a secret in an untracked ordinary file while allowing placeholders', async () => {
      const secret = `ghp_${'aB3d'.repeat(9)}`;
      writeFileSync(join(repo, 'scratch.ts'), `export const token = '${secret}';\n`);

      const message = await service.checkpoint(repo, 'must reject untracked secret').then(
        () => 'unexpected success',
        (error: unknown) => error instanceof Error ? error.message : String(error),
      );
      expect(message).toContain('Potential secret content');
      expect(message).toContain('scratch.ts');
      expect(message).not.toContain(secret);
      expect(await readGitAsync(repo, ['diff', '--cached', '--name-only'])).toBe('');

      rmSync(join(repo, 'scratch.ts'));
      writeFileSync(
        join(repo, 'placeholder.ts'),
        "export const openai = 'sk-proj-placeholder';\n" +
        "export const longOpenai = 'sk-proj-placeholderplaceholderplaceholderplaceholder';\n" +
        "export const github = 'ghp_example';\n",
      );
      await expect(service.checkpoint(repo, 'allow documented placeholders')).resolves.toMatchObject({
        committed: true,
        clean: true,
      });
    });

    it('does not exempt a credential merely because random-looking token data contains a marker word', async () => {
      const secret = `sk-proj-example${'A1b2C3d4'.repeat(6)}`;
      writeFileSync(join(repo, 'embedded-marker.ts'), `export const token = '${secret}';\n`);

      const message = await service.checkpoint(repo, 'must reject embedded marker token').then(
        () => 'unexpected success',
        (error: unknown) => error instanceof Error ? error.message : String(error),
      );
      expect(message).toContain('Potential secret content');
      expect(message).toContain('embedded-marker.ts');
      expect(message).not.toContain(secret);
    });

    it('scans the exact NUL-delimited Git path when a filename contains surrounding whitespace', async () => {
      const path = ' leading-secret.ts ';
      const secret = `sk-proj-${'A1b2C3d4'.repeat(8)}`;
      writeFileSync(join(repo, path), `export const token = '${secret}';\n`);

      const message = await service.checkpoint(repo, 'must reject whitespace path secret').then(
        () => 'unexpected success',
        (error: unknown) => error instanceof Error ? error.message : String(error),
      );

      expect(message).toContain('Potential secret content');
      expect(message).toContain(path);
      expect(message).not.toContain(secret);
      expect(await readGitAsync(repo, ['diff', '--cached', '--name-only'])).toBe('');
      expect(await readGitAsync(repo, ['rev-list', '--count', 'HEAD'])).toBe('1');
    });

    it('fails closed before staging a changed symlink', async () => {
      const outside = `${repo}-outside.txt`;
      writeFileSync(outside, 'outside workspace\n');
      symlinkSync(outside, join(repo, 'linked-config.ts'));
      try {
        await expect(service.checkpoint(repo, 'must reject symlink'))
          .rejects.toThrow('could not safely inspect candidate paths: linked-config.ts');
        expect(await readGitAsync(repo, ['diff', '--cached', '--name-only'])).toBe('');
      } finally {
        rmSync(outside, { force: true });
      }
    });

    it('fails closed when a checkpoint candidate exceeds the bounded content scan', async () => {
      writeFileSync(join(repo, 'oversized.txt'), 'x'.repeat(1_048_577));

      await expect(service.checkpoint(repo, 'must reject scan overflow'))
        .rejects.toThrow('could not safely inspect candidate paths: oversized.txt');
      expect(await readGitAsync(repo, ['diff', '--cached', '--name-only'])).toBe('');
      expect(await readGitAsync(repo, ['rev-list', '--count', 'HEAD'])).toBe('1');
    });
  });
});

function validateCheckpointRange(
  service: GitService,
  path: string,
  fromHead: string,
  toHead: string,
): Promise<void> {
  return service.validateCheckpointRange(path, fromHead, toHead);
}
