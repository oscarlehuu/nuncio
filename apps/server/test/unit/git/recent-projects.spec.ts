import { BadRequestException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseModule } from '../../../src/db/database.module';
import { GitModule } from '../../../src/git/git.module';
import { GitController } from '../../../src/git/git.controller';
import { RecentProjectsRepository } from '../../../src/git/recent-projects.repository';

async function runGitAsync(cwd: string, args: string[]): Promise<void> {
  const proc = Bun.spawn(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  const code = await proc.exited;
  if (code !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`git ${args.join(' ')} failed: ${stderr}`);
  }
}

async function initRepo(dir: string): Promise<void> {
  mkdirSync(dir, { recursive: true });
  await runGitAsync(dir, ['init', '-b', 'main']);
  writeFileSync(join(dir, 'README.md'), '# test\n');
}

describe('Recent projects', () => {
  let module: TestingModule;
  let controller: GitController;
  let repository: RecentProjectsRepository;
  let tempDir: string;
  let dataDir: string;
  let repo: string;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'nuncio-recent-projects-'));
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-recent-projects-db-'));
    process.env.NUNCIO_DATA_DIR = dataDir;
    repo = join(tempDir, 'repo-a');
    await initRepo(repo);

    module = await Test.createTestingModule({
      imports: [DatabaseModule, GitModule],
    }).compile();
    controller = module.get(GitController);
    repository = module.get(RecentProjectsRepository);
  });

  afterEach(async () => {
    await module.close();
    rmSync(tempDir, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.NUNCIO_DATA_DIR;
  });

  it('rejects an empty path', async () => {
    await expect(controller.recordRecent({ path: '  ' })).rejects.toThrow(BadRequestException);
  });

  it('rejects a non-git path', async () => {
    const plainDir = join(tempDir, 'not-a-repo');
    mkdirSync(plainDir, { recursive: true });
    await expect(controller.recordRecent({ path: plainDir })).rejects.toThrow(BadRequestException);
  });

  it('records the resolved repo root and returns it via GET', async () => {
    const nested = join(repo, 'src');
    mkdirSync(nested, { recursive: true });
    const stored = await controller.recordRecent({ path: nested });
    expect(stored.path).toBe(realpathSync.native(repo));
    expect(stored.name).toBe('repo-a');

    const { items } = controller.listRecent();
    expect(items).toHaveLength(1);
    expect(items[0].path).toBe(realpathSync.native(repo));
  });

  it('upserts on re-record and lists most-recent-first', async () => {
    const repoB = join(tempDir, 'repo-b');
    await initRepo(repoB);

    repository.record(repo);
    await new Promise((r) => setTimeout(r, 2));
    repository.record(repoB);
    const listed = repository.list();
    expect(listed.map((row) => row.path)).toEqual([repoB, repo]);

    await new Promise((r) => setTimeout(r, 2));
    repository.record(repo);
    const reordered = repository.list();
    expect(reordered.map((row) => row.path)).toEqual([repo, repoB]);
    expect(reordered).toHaveLength(2);
  });

  it('filters non-existent paths from list without deleting rows', () => {
    repository.record(repo);
    repository.record(join(tempDir, 'ghost-repo'));
    const listed = repository.list();
    expect(listed.map((row) => row.path)).toEqual([repo]);
  });

  it('prunes to the 20 newest rows', async () => {
    for (let i = 0; i < 25; i += 1) {
      const dir = join(tempDir, `bulk-${String(i).padStart(2, '0')}`);
      mkdirSync(dir, { recursive: true });
      repository.record(dir);
      await new Promise((r) => setTimeout(r, 1));
    }
    const listed = repository.list();
    expect(listed).toHaveLength(20);
    expect(listed[0].name).toBe('bulk-24');
    expect(listed[19].name).toBe('bulk-05');
  });

  it('rejects an empty identity path', () => {
    expect(() => controller.resolveIdentity(undefined)).toThrow(BadRequestException);
    expect(() => controller.resolveIdentity('  ')).toThrow(BadRequestException);
  });

  it('resolves identity for a git repo path', async () => {
    const identity = await controller.resolveIdentity(repo);
    expect(identity.kind).toBe('repo');
    expect(identity.repoRoot).toBe(realpathSync.native(repo));
    expect(identity.remoteUrl).toBeNull();
    expect(identity.isWorktree).toBe(false);
  });
});
