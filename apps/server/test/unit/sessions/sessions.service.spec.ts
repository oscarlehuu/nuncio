import { BadRequestException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentsModule } from '../../../src/agents/agents.module';
import { DatabaseModule } from '../../../src/db/database.module';
import { GitModule } from '../../../src/git/git.module';
import { SessionsRepository } from '../../../src/sessions/persistence/sessions.repository';
import { SessionsPersistenceModule } from '../../../src/sessions/sessions.persistence.module';
import { SessionsService } from '../../../src/sessions/sessions.service';

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
  await runGitAsync(dir, ['add', 'README.md']);
  await runGitAsync(dir, ['config', 'user.email', 'test@nuncio.local']);
  await runGitAsync(dir, ['config', 'user.name', 'Nuncio Test']);
  await runGitAsync(dir, ['commit', '-m', 'init']);
}

describe('SessionsService lifecycle (phase 3)', () => {
  let service: SessionsService;
  let sessions: SessionsRepository;
  let dataDir: string;
  let repoPath: string;
  let workspacesDir: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-svc-test-'));
    repoPath = mkdtempSync(join(tmpdir(), 'nuncio-svc-repo-'));
    workspacesDir = mkdtempSync(join(tmpdir(), 'nuncio-svc-ws-'));
    process.env.NUNCIO_DATA_DIR = dataDir;
    process.env.NUNCIO_FORCE_MOCK = '1';
    process.env.NUNCIO_WORKSPACES_DIR = workspacesDir;
    await initRepo(repoPath);

    const module: TestingModule = await Test.createTestingModule({
      imports: [DatabaseModule, GitModule, SessionsPersistenceModule, AgentsModule],
      providers: [SessionsService],
    }).compile();

    service = module.get(SessionsService);
    sessions = module.get(SessionsRepository);
  });

  afterAll(async () => {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(repoPath, { recursive: true, force: true });
    rmSync(workspacesDir, { recursive: true, force: true });
    delete process.env.NUNCIO_DATA_DIR;
    delete process.env.NUNCIO_FORCE_MOCK;
    delete process.env.NUNCIO_WORKSPACES_DIR;
  });

  function seedSession(status: 'IDLE' | 'PAUSED' | 'RUNNING' | 'ARCHIVED' | 'ERROR') {
    const created = sessions.create({ prompt: 'Lifecycle test session', provider: 'mock' });
    sessions.updateStatus(created.id, 'RUNNING');
    if (status === 'RUNNING') return created.id;
    if (status === 'ERROR') {
      sessions.updateStatus(created.id, 'ERROR');
      return created.id;
    }
    sessions.updateStatus(created.id, 'IDLE');
    if (status === 'IDLE') return created.id;
    if (status === 'PAUSED') {
      sessions.updateStatus(created.id, 'PAUSED');
      return created.id;
    }
    sessions.updateStatus(created.id, 'ARCHIVED');
    return created.id;
  }

  it('steer requires IDLE or PAUSED session', async () => {
    const idleId = seedSession('IDLE');
    const pausedId = seedSession('PAUSED');

    await expect(service.steer(idleId, 'Continue with tests')).resolves.toMatchObject({
      status: 'IDLE',
    });
    await expect(service.steer(pausedId, 'Resume from pause')).resolves.toMatchObject({
      status: 'IDLE',
    });
  });

  it('rejects steer when session is RUNNING', async () => {
    const id = seedSession('RUNNING');
    await expect(service.steer(id, 'Not yet')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects steer when session is ARCHIVED', async () => {
    const id = seedSession('ARCHIVED');
    await expect(service.steer(id, 'Too late')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('archive transitions IDLE and PAUSED sessions to ARCHIVED', () => {
    const idleId = seedSession('IDLE');
    const pausedId = seedSession('PAUSED');

    expect(service.archive(idleId).status).toBe('ARCHIVED');
    expect(service.archive(pausedId).status).toBe('ARCHIVED');
    expect(service.get(idleId)?.status).toBe('ARCHIVED');
    expect(service.get(pausedId)?.status).toBe('ARCHIVED');
  });

  it('rejects archive when session is RUNNING', () => {
    const id = seedSession('RUNNING');
    expect(() => service.archive(id)).toThrow(BadRequestException);
  });

  it('list excludes archived sessions by default', () => {
    const activeId = seedSession('IDLE');
    const archivedId = seedSession('IDLE');
    service.archive(archivedId);

    const listed = service.list();
    expect(listed.some((s) => s.id === activeId)).toBe(true);
    expect(listed.some((s) => s.id === archivedId)).toBe(false);
    expect(listed.every((s) => s.status !== 'ARCHIVED')).toBe(true);
  });

  it('list includes archived when includeArchived is true', () => {
    const archivedId = seedSession('IDLE');
    service.archive(archivedId);

    const listed = service.list(true);
    expect(listed.some((s) => s.id === archivedId && s.status === 'ARCHIVED')).toBe(true);
  });

  describe('per-session provider selection', () => {
    it('defaults to mock when provider omitted and only mock is available', async () => {
      const session = await service.create({ prompt: 'default provider task' });
      expect(session.provider).toBe('mock');
      await waitForIdle(service, session.id);
    });

    it('stores an explicit mock provider', async () => {
      const session = await service.create({ prompt: 'explicit mock task', provider: 'mock' });
      expect(session.provider).toBe('mock');
      await waitForIdle(service, session.id);
    });

    it('rejects an unknown provider', async () => {
      await expect(
        service.create({ prompt: 'bad provider', provider: 'missing' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects an unavailable provider', async () => {
      await expect(
        service.create({ prompt: 'pi without auth', provider: 'pi' }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('workspace worktree integration', () => {
    it('creates a session with worktree when projectPath is provided', async () => {
      const session = await service.create({
        prompt: 'Fix auth middleware',
        provider: 'mock',
        projectPath: repoPath,
        baseBranch: 'main',
      });

      expect(session.projectPath).toBe(repoPath);
      expect(session.baseBranch).toBe('main');
      expect(session.worktreePath).toBe(join(workspacesDir, session.id));
      expect(session.branch).toBe(`nuncio/${session.id}-fix-auth-middleware`);

      await waitForIdle(service, session.id);
    });

    it('does not persist a session when worktree creation fails', async () => {
      const before = service.list(true).length;
      await expect(
        service.create({
          prompt: 'Broken workspace',
          provider: 'mock',
          projectPath: '/definitely/not/a/git/repo',
          baseBranch: 'main',
        }),
      ).rejects.toThrow(BadRequestException);
      expect(service.list(true).length).toBe(before);
    });
  });
});

async function waitForIdle(service: SessionsService, id: string, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const session = service.get(id);
    if (session?.status === 'IDLE' || session?.status === 'ERROR') return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Session ${id} did not reach IDLE in time`);
}
