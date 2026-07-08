import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Test, TestingModule } from '@nestjs/testing';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseModule } from '../../../../src/db/database.module';
import { GitModule } from '../../../../src/git/git.module';
import { SessionDiffService } from '../../../../src/sessions/diff/session-diff.service';

/**
 * Session diff service (rung 3 sub-phase D) — RED until implemented. Base
 * derivation over FIXTURE repos (git module's spec pattern): a worktree session
 * diffs vs its baseBranch (full delta), a plain cwd session diffs uncommitted work.
 */
async function git(cwd: string, args: string[]): Promise<void> {
  const proc = Bun.spawn(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  if ((await proc.exited) !== 0) throw new Error(`git ${args.join(' ')} failed`);
}
async function initRepo(dir: string): Promise<void> {
  mkdirSync(dir, { recursive: true });
  await git(dir, ['init', '-b', 'main']);
  await git(dir, ['config', 'user.email', 't@t']);
  await git(dir, ['config', 'user.name', 'T']);
  writeFileSync(join(dir, 'a.ts'), 'export const a = 1;\n');
  await git(dir, ['add', '.']);
  await git(dir, ['commit', '-m', 'init']);
}

describe('SessionDiffService', () => {
  let module: TestingModule;
  let svc: SessionDiffService;
  let dataDir: string;
  let repo: string;
  let workDir: string;

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-diff-data-'));
    workDir = mkdtempSync(join(tmpdir(), 'nuncio-diff-work-'));
    process.env.NUNCIO_DATA_DIR = dataDir;
    process.env.NUNCIO_WORKSPACES_DIR = workDir;
    repo = join(workDir, 'repo');
    await initRepo(repo);

    module = await Test.createTestingModule({
      imports: [DatabaseModule, GitModule],
      providers: [SessionDiffService],
    }).compile();
    svc = module.get(SessionDiffService);
  });

  afterEach(async () => {
    await module.close();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
    delete process.env.NUNCIO_DATA_DIR;
    delete process.env.NUNCIO_WORKSPACES_DIR;
  });

  it('a plain cwd session (no base) surfaces uncommitted changes', async () => {
    writeFileSync(join(repo, 'a.ts'), 'export const a = 2;\n'); // uncommitted edit
    svc.resolveTarget = () => ({ gitDir: repo, base: null });
    const diff = await svc.diff('s1');
    expect(diff.files.some((f) => f.path === 'a.ts')).toBe(true);
    expect(diff.files.find((f) => f.path === 'a.ts')!.status).toBe('modified');
  });

  it('an untracked new file is surfaced (not dropped)', async () => {
    writeFileSync(join(repo, 'fresh.ts'), 'export const fresh = true;\n');
    svc.resolveTarget = () => ({ gitDir: repo, base: null });
    const diff = await svc.diff('s1');
    expect(diff.files.some((f) => f.path === 'fresh.ts')).toBe(true);
  });

  it('a worktree session diffs vs its base branch (the full session delta)', async () => {
    // Branch off, commit a change on the branch → diff vs main shows it.
    await git(repo, ['checkout', '-b', 'feature']);
    writeFileSync(join(repo, 'a.ts'), 'export const a = 99;\n');
    await git(repo, ['commit', '-am', 'feature work']);
    svc.resolveTarget = () => ({ gitDir: repo, base: 'main' });
    const diff = await svc.diff('s1');
    expect(diff.files.some((f) => f.path === 'a.ts')).toBe(true);
  });

  it('a clean worktree → empty diff, never a throw', async () => {
    svc.resolveTarget = () => ({ gitDir: repo, base: null });
    expect((await svc.diff('s1')).files).toEqual([]);
  });

  it('a non-git cwd → clean empty state (tolerated)', async () => {
    const notARepo = mkdtempSync(join(tmpdir(), 'nuncio-notrepo-'));
    try {
      svc.resolveTarget = () => ({ gitDir: notARepo, base: null });
      expect((await svc.diff('s1')).files).toEqual([]);
    } finally {
      rmSync(notARepo, { recursive: true, force: true });
    }
  });

  it('a bad/injection base ref (leading -) is rejected', async () => {
    svc.resolveTarget = () => ({ gitDir: repo, base: '--output=/tmp/x' });
    await expect(svc.diff('s1')).rejects.toThrow();
  });
});
