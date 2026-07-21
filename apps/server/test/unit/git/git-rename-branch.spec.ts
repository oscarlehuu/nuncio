import { BadRequestException } from '@nestjs/common';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
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

async function initRepo(dir: string): Promise<void> {
  mkdirSync(dir, { recursive: true });
  await runGitAsync(dir, ['init', '-b', 'main']);
  writeFileSync(join(dir, 'README.md'), '# test\n');
  await runGitAsync(dir, ['add', 'README.md']);
  await runGitAsync(dir, ['config', 'user.email', 'test@nuncio.local']);
  await runGitAsync(dir, ['config', 'user.name', 'Nuncio Test']);
  await runGitAsync(dir, ['commit', '-m', 'init']);
}

describe('GitService.renameWorktreeBranch', () => {
  let service: GitService;
  let root: string;
  let repo: string;
  let workspacesDir: string;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'nuncio-rename-branch-'));
    repo = join(root, 'repo');
    workspacesDir = join(root, 'workspaces');
    process.env.NUNCIO_PROJECT_ROOTS = root;
    process.env.NUNCIO_WORKSPACES_DIR = workspacesDir;
    service = new GitService({
      resolve: (key: string) => process.env[key],
    } as never);
    await initRepo(repo);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    delete process.env.NUNCIO_PROJECT_ROOTS;
    delete process.env.NUNCIO_WORKSPACES_DIR;
  });

  it('renames the checked-out worktree branch', async () => {
    const { worktreePath, branch } = await service.createWorktree(repo, 'main', 's1', 'old slug');

    await service.renameWorktreeBranch(worktreePath, branch, 'nuncio/fix-auth-refresh');

    await expect(readGitAsync(worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD'])).resolves.toBe(
      'nuncio/fix-auth-refresh',
    );
  });

  it('refuses when the worktree is no longer on the expected branch', async () => {
    const { worktreePath } = await service.createWorktree(repo, 'main', 's2', 'task');

    await expect(
      service.renameWorktreeBranch(worktreePath, 'nuncio/some-other-branch', 'nuncio/next'),
    ).rejects.toThrow(BadRequestException);
  });

  it('refuses when the target branch already exists', async () => {
    const { worktreePath, branch } = await service.createWorktree(repo, 'main', 's3', 'task');
    await runGitAsync(repo, ['branch', 'nuncio/taken']);

    await expect(
      service.renameWorktreeBranch(worktreePath, branch, 'nuncio/taken'),
    ).rejects.toThrow(BadRequestException);
  });
});
