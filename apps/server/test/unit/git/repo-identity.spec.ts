import { computeRepoIdentity, normalizeRemoteUrl } from '../../../src/git/repo-identity';

describe('normalizeRemoteUrl', () => {
  it('normalizes an https remote to host/owner/repo', () => {
    expect(normalizeRemoteUrl('https://github.com/octo/repo.git')).toBe('github.com/octo/repo');
  });

  it('normalizes an scp-like ssh remote to the same identity as https', () => {
    expect(normalizeRemoteUrl('git@github.com:octo/repo.git')).toBe('github.com/octo/repo');
    expect(normalizeRemoteUrl('git@github.com:octo/repo.git')).toBe(
      normalizeRemoteUrl('https://github.com/octo/repo'),
    );
  });

  it('lowercases host and path and strips a trailing .git', () => {
    expect(normalizeRemoteUrl('https://GitHub.com/Octo/Repo')).toBe('github.com/octo/repo');
  });

  it('returns null for empty or unparseable input', () => {
    expect(normalizeRemoteUrl(null)).toBeNull();
    expect(normalizeRemoteUrl('')).toBeNull();
    expect(normalizeRemoteUrl('   ')).toBeNull();
  });
});

describe('computeRepoIdentity', () => {
  it('groups the main checkout and a worktree of the same remote under one identity', () => {
    const main = computeRepoIdentity({
      path: '/repos/app',
      toplevel: '/repos/app',
      commonDir: '/repos/app/.git',
      remoteUrl: 'git@github.com:octo/app.git',
    });
    const worktree = computeRepoIdentity({
      path: '/home/me/workspaces/s1',
      toplevel: '/home/me/workspaces/s1',
      commonDir: '/repos/app/.git',
      remoteUrl: 'https://github.com/octo/app',
    });

    expect(main.kind).toBe('repo');
    expect(worktree.kind).toBe('repo');
    expect(main.id).toBe(worktree.id);
    expect(main.repoRoot).toBe('/repos/app');
    expect(worktree.repoRoot).toBe('/repos/app');
    // The main checkout's top-level equals the repo root; the worktree's does not.
    expect(main.isWorktree).toBe(false);
    expect(worktree.isWorktree).toBe(true);
  });

  it('groups worktrees of a remote-less repo by their shared common git dir', () => {
    const main = computeRepoIdentity({
      path: '/repos/local',
      toplevel: '/repos/local',
      commonDir: '/repos/local/.git',
      remoteUrl: null,
    });
    const worktree = computeRepoIdentity({
      path: '/tmp/wt',
      toplevel: '/tmp/wt',
      commonDir: '/repos/local/.git',
      remoteUrl: null,
    });
    expect(main.id).toBe(worktree.id);
    expect(main.remoteUrl).toBeNull();
    expect(main.repoRoot).toBe('/repos/local');
  });

  it('keeps path identity for a non-git folder (fallback)', () => {
    const identity = computeRepoIdentity({ path: '/some/loose/folder', toplevel: null });
    expect(identity.kind).toBe('path');
    expect(identity.id).toBe('/some/loose/folder');
    expect(identity.repoRoot).toBe('/some/loose/folder');
    expect(identity.remoteUrl).toBeNull();
    expect(identity.isWorktree).toBe(false);
  });

  it('gives two different repos distinct identities', () => {
    const a = computeRepoIdentity({
      path: '/repos/a',
      toplevel: '/repos/a',
      commonDir: '/repos/a/.git',
      remoteUrl: 'git@github.com:octo/a.git',
    });
    const b = computeRepoIdentity({
      path: '/repos/b',
      toplevel: '/repos/b',
      commonDir: '/repos/b/.git',
      remoteUrl: 'git@github.com:octo/b.git',
    });
    expect(a.id).not.toBe(b.id);
  });
});

import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { GitService } from '../../../src/git/git.service';

async function runGit(cwd: string, args: string[]): Promise<void> {
  const proc = Bun.spawn(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  const code = await proc.exited;
  if (code !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`git ${args.join(' ')} failed: ${stderr}`);
  }
}

describe('GitService.resolveRepoIdentity', () => {
  let base: string;
  let repo: string;
  let worktree: string;
  let loose: string;
  let service: GitService;

  beforeAll(async () => {
    base = mkdtempSync(join(tmpdir(), 'nuncio-identity-'));
    repo = join(base, 'app');
    worktree = join(base, 'wt-app');
    loose = join(base, 'loose');
    mkdirSync(repo, { recursive: true });
    mkdirSync(loose, { recursive: true });
    await runGit(repo, ['init', '-b', 'main']);
    await runGit(repo, ['config', 'user.email', 'test@nuncio.local']);
    await runGit(repo, ['config', 'user.name', 'Nuncio Test']);
    await runGit(repo, ['remote', 'add', 'origin', 'git@github.com:octo/app.git']);
    writeFileSync(join(repo, 'README.md'), '# app\n');
    await runGit(repo, ['add', 'README.md']);
    await runGit(repo, ['commit', '-m', 'init']);
    await runGit(repo, ['worktree', 'add', '-b', 'feature', worktree]);

    service = new GitService({ resolve: (key: string) => process.env[key] } as never);
  });

  afterAll(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it('resolves the main checkout and a worktree of one repo to one identity', async () => {
    const mainIdentity = await service.resolveRepoIdentity(repo);
    const worktreeIdentity = await service.resolveRepoIdentity(worktree);

    expect(mainIdentity.kind).toBe('repo');
    expect(worktreeIdentity.kind).toBe('repo');
    expect(mainIdentity.id).toBe(worktreeIdentity.id);
    expect(mainIdentity.remoteUrl).toBe('github.com/octo/app');
    expect(mainIdentity.repoRoot).toBe(worktreeIdentity.repoRoot);
    // Only the linked worktree is flagged as a worktree.
    expect(mainIdentity.isWorktree).toBe(false);
    expect(worktreeIdentity.isWorktree).toBe(true);
  });

  it('keeps path identity for a non-git folder', async () => {
    const identity = await service.resolveRepoIdentity(loose);
    expect(identity.kind).toBe('path');
    expect(identity.remoteUrl).toBeNull();
    expect(identity.id).toBe(identity.repoRoot);
    expect(identity.isWorktree).toBe(false);
  });

  it('caches an identity so a second resolve of the same path does not re-shell', async () => {
    const cached = new GitService({ resolve: (key: string) => process.env[key] } as never);
    const realGit = cached.repoIdentityGit;
    let calls = 0;
    cached.repoIdentityGit = (args, cwd) => {
      calls += 1;
      return realGit(args, cwd);
    };

    const first = await cached.resolveRepoIdentity(repo);
    const callsAfterFirst = calls;
    const second = await cached.resolveRepoIdentity(repo);

    expect(first.id).toBe(second.id);
    expect(callsAfterFirst).toBeGreaterThan(0);
    // No additional shell-outs on the cached resolve.
    expect(calls).toBe(callsAfterFirst);
  });

  it('dedupes concurrent resolves of the same path into a single resolution', async () => {
    const cached = new GitService({ resolve: (key: string) => process.env[key] } as never);
    const realGit = cached.repoIdentityGit;
    let calls = 0;
    cached.repoIdentityGit = (args, cwd) => {
      calls += 1;
      return realGit(args, cwd);
    };

    const [a, b] = await Promise.all([
      cached.resolveRepoIdentity(repo),
      cached.resolveRepoIdentity(repo),
    ]);

    expect(a.id).toBe(b.id);
    // One resolution's git calls (show-toplevel + common-dir + remote), not two races.
    expect(calls).toBeLessThanOrEqual(3);
  });
});
