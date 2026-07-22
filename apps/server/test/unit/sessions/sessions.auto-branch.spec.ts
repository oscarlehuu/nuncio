import { Test, TestingModule } from '@nestjs/testing';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentsModule } from '../../../src/agents/agents.module';
import { CursorLocalModule } from '../../../src/cursor-local/cursor-local.module';
import { DatabaseModule } from '../../../src/db/database.module';
import { GitModule } from '../../../src/git/git.module';
import { GitService } from '../../../src/git/git.service';
import { SessionsPersistenceModule } from '../../../src/sessions/sessions.persistence.module';
import { SessionsRepository } from '../../../src/sessions/persistence/sessions.repository';
import { SessionsService } from '../../../src/sessions/sessions.service';
import {
  configureSimulatedCursorEnv,
  withSimulatedCursorProvider,
} from '../../helpers/simulated-cursor-app';

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
  await proc.exited;
  return (await new Response(proc.stdout).text()).trim();
}

describe('SessionsService.applyAutoBranch', () => {
  let module: TestingModule;
  let service: SessionsService;
  let repo: SessionsRepository;
  let git: GitService;
  let dataDir: string;
  let root: string;
  let repoDir: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-auto-branch-db-'));
    root = mkdtempSync(join(tmpdir(), 'nuncio-auto-branch-'));
    repoDir = join(root, 'repo');
    process.env.NUNCIO_DATA_DIR = dataDir;
    process.env.NUNCIO_PROJECT_ROOTS = root;
    process.env.NUNCIO_WORKSPACES_DIR = join(root, 'workspaces');
    configureSimulatedCursorEnv();

    mkdirSync(repoDir, { recursive: true });
    await runGitAsync(repoDir, ['init', '-b', 'main']);
    writeFileSync(join(repoDir, 'README.md'), '# test\n');
    await runGitAsync(repoDir, ['add', 'README.md']);
    await runGitAsync(repoDir, ['config', 'user.email', 'test@nuncio.local']);
    await runGitAsync(repoDir, ['config', 'user.name', 'Nuncio Test']);
    await runGitAsync(repoDir, ['commit', '-m', 'init']);

    module = await withSimulatedCursorProvider(
      Test.createTestingModule({
        imports: [DatabaseModule, SessionsPersistenceModule, AgentsModule, GitModule, CursorLocalModule],
        providers: [SessionsService],
      }),
    ).compile();

    service = module.get(SessionsService);
    repo = module.get(SessionsRepository);
    git = module.get(GitService);
  });

  afterAll(async () => {
    await module.close();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
    delete process.env.NUNCIO_DATA_DIR;
    delete process.env.NUNCIO_PROJECT_ROOTS;
    delete process.env.NUNCIO_WORKSPACES_DIR;
    delete process.env.CURSOR_API_KEY;
  });

  async function makeWorktreeSession(id: string) {
    const worktree = await git.createWorktree(repoDir, 'main', id, 'initial task');
    const session = repo.create({
      id,
      prompt: 'initial task',
      provider: 'cursor',
      projectPath: repoDir,
      worktreePath: worktree.worktreePath,
      branch: worktree.branch,
    });
    return { session, worktree };
  }

  it('renames the worktree branch and updates the session row', async () => {
    const { session, worktree } = await makeWorktreeSession('ab1');

    await service.applyAutoBranch(session.id, worktree.branch, 'fix-auth-refresh');

    expect(repo.findById(session.id)?.branch).toBe('nuncio/fix-auth-refresh');
    await expect(
      readGitAsync(worktree.worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD']),
    ).resolves.toBe('nuncio/fix-auth-refresh');
  });

  it('suffixes the session id when the generated name collides', async () => {
    await runGitAsync(repoDir, ['branch', 'nuncio/fix-login']);
    const { session, worktree } = await makeWorktreeSession('ab2');

    await service.applyAutoBranch(session.id, worktree.branch, 'fix-login');

    expect(repo.findById(session.id)?.branch).toBe('nuncio/fix-login-ab2');
  });

  it('is a no-op when the branch changed since create', async () => {
    const { session, worktree } = await makeWorktreeSession('ab3');

    await service.applyAutoBranch(session.id, 'nuncio/stale-expected', 'anything');

    expect(repo.findById(session.id)?.branch).toBe(worktree.branch);
  });

  it('create() rollback never deletes an adopted (handoff) worktree', async () => {
    const worktree = await git.createWorktree(repoDir, 'main', 'ab9', 'source task');
    repo.create({ id: 'ab9', prompt: 'source', provider: 'cursor' });

    // Duplicate id forces the insert to fail AFTER the adoption path resolved
    // the source worktree — rollback must leave that worktree untouched.
    await expect(
      service.create({
        id: 'ab9',
        prompt: 'handoff successor',
        provider: 'cursor',
        projectPath: repoDir,
        worktreePath: worktree.worktreePath,
        branch: worktree.branch,
      }),
    ).rejects.toThrow();

    await expect(
      readGitAsync(worktree.worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD']),
    ).resolves.toBe(worktree.branch);
  });

  it('is a no-op for sessions that already carry a pull request', async () => {
    const { session, worktree } = await makeWorktreeSession('ab4');
    repo.updateForgeState(session.id, {
      forgeProvider: 'github',
      pullRequestUrl: 'https://github.com/o/r/pull/1',
      pullRequestNumber: 1,
      pullRequestState: 'open',
      forgeStatus: 'open',
    });

    await service.applyAutoBranch(session.id, worktree.branch, 'anything');

    expect(repo.findById(session.id)?.branch).toBe(worktree.branch);
  });
});
