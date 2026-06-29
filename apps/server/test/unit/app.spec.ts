import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AppModule } from '../../src/app.module';
import {
  configureSimulatedCursorEnv,
  withSimulatedCursorProvider,
} from '../helpers/simulated-cursor-app';

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

describe('Nuncio API', () => {
  let app: INestApplication;
  let dataDir: string;
  let rootsDir: string;
  let repoPath: string;
  let workspacesDir: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-test-'));
    rootsDir = mkdtempSync(join(tmpdir(), 'nuncio-test-roots-'));
    repoPath = join(rootsDir, 'sample-repo');
    workspacesDir = mkdtempSync(join(tmpdir(), 'nuncio-test-ws-'));
    await initRepo(repoPath);

    process.env.NUNCIO_DATA_DIR = dataDir;
    configureSimulatedCursorEnv();
    process.env.NUNCIO_PROJECT_ROOTS = rootsDir;
    process.env.NUNCIO_WORKSPACES_DIR = workspacesDir;

    const moduleFixture: TestingModule = await withSimulatedCursorProvider(
      Test.createTestingModule({
        imports: [AppModule],
      }),
    ).compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(rootsDir, { recursive: true, force: true });
    rmSync(workspacesDir, { recursive: true, force: true });
    delete process.env.NUNCIO_DATA_DIR;
    delete process.env.CURSOR_API_KEY;
    delete process.env.NUNCIO_PROJECT_ROOTS;
    delete process.env.NUNCIO_WORKSPACES_DIR;
  });

  it('GET /api/health returns ok', async () => {
    const res = await request(app.getHttpServer()).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  it('POST /api/sessions creates a session', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/sessions')
      .send({ prompt: 'Fix the flaky websocket test' });

    expect(res.status).toBe(201);
    expect(res.body.id).toBeDefined();
    expect(res.body.status).toBe('CREATED');
    expect(res.body.title).toContain('websocket');
  });

  it('GET /api/sessions lists sessions', async () => {
    const res = await request(app.getHttpServer()).get('/api/sessions');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);
  });

  it('GET /api/sessions/:id/events returns events after run', async () => {
    const created = await request(app.getHttpServer())
      .post('/api/sessions')
      .send({ prompt: 'Write a hello world script' });

    const id = created.body.id;
    await waitForIdle(app, id);

    const res = await request(app.getHttpServer()).get(`/api/sessions/${id}/events`);
    expect(res.status).toBe(200);
    expect(res.body.some((e: { type: string }) => e.type === 'user_message')).toBe(true);
    expect(res.body.some((e: { type: string }) => e.type === 'assistant_message')).toBe(true);
  });

  describe('phase 3 session lifecycle', () => {
    it('POST /api/sessions/:id/steer succeeds when IDLE', async () => {
      const created = await request(app.getHttpServer())
        .post('/api/sessions')
        .send({ prompt: 'Build the auth module' });

      const id = created.body.id;
      await waitForIdle(app, id);

      const steer = await request(app.getHttpServer())
        .post(`/api/sessions/${id}/steer`)
        .send({ message: 'Focus on unit tests only' });

      expect(steer.status).toBe(201);
      await waitForIdle(app, id);

      const events = await request(app.getHttpServer()).get(`/api/sessions/${id}/events`);
      expect(events.body.some((e: { type: string }) => e.type === 'steer_message')).toBe(true);
    });

    it('POST /api/sessions/:id/steer succeeds when PAUSED', async () => {
      const created = await request(app.getHttpServer())
        .post('/api/sessions')
        .send({ prompt: 'Refactor the session store' });

      const id = created.body.id;
      await waitForIdle(app, id);

      const paused = await request(app.getHttpServer()).post(`/api/sessions/${id}/pause`);
      expect(paused.status).toBe(201);
      expect(paused.body.status).toBe('PAUSED');

      const steer = await request(app.getHttpServer())
        .post(`/api/sessions/${id}/steer`)
        .send({ message: 'Resume with integration tests' });

      expect(steer.status).toBe(201);
      await waitForIdle(app, id);
      expect((await request(app.getHttpServer()).get(`/api/sessions/${id}`)).body.status).toBe('IDLE');
    });

    it('POST /api/sessions/:id/archive transitions to ARCHIVED', async () => {
      const created = await request(app.getHttpServer())
        .post('/api/sessions')
        .send({ prompt: 'Archive me when done' });

      const id = created.body.id;
      await waitForIdle(app, id);

      const archived = await request(app.getHttpServer()).post(`/api/sessions/${id}/archive`);
      expect(archived.status).toBe(201);
      expect(archived.body.status).toBe('ARCHIVED');
    });

    it('GET /api/sessions excludes archived sessions', async () => {
      const created = await request(app.getHttpServer())
        .post('/api/sessions')
        .send({ prompt: 'Hidden after archive' });

      const id = created.body.id;
      await waitForIdle(app, id);
      await request(app.getHttpServer()).post(`/api/sessions/${id}/archive`);

      const list = await request(app.getHttpServer()).get('/api/sessions');
      expect(list.status).toBe(200);
      expect(list.body.some((s: { id: string }) => s.id === id)).toBe(false);

      const withArchived = await request(app.getHttpServer()).get('/api/sessions?includeArchived=true');
      expect(withArchived.body.some((s: { id: string; status: string }) => s.id === id && s.status === 'ARCHIVED')).toBe(
        true,
      );
    });
  });

  describe('phase 4 workspace integration', () => {
    it('GET /api/projects lists git repos from configured roots', async () => {
      const res = await request(app.getHttpServer()).get('/api/projects');
      expect(res.status).toBe(200);
      expect(res.body.some((project: { path: string }) => project.path === repoPath)).toBe(true);
    });

    it('GET /api/projects/branches returns branches for a repo path', async () => {
      const res = await request(app.getHttpServer()).get(`/api/projects/branches?path=${encodeURIComponent(repoPath)}`);
      expect(res.status).toBe(200);
      expect(res.body.some((branch: { name: string }) => branch.name === 'main')).toBe(true);
    });

    it('POST /api/sessions with projectPath defaults to the selected workspace', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/sessions')
        .send({
          prompt: 'Inspect workspace support',
          projectPath: repoPath,
          baseBranch: 'main',
        });

      expect(res.status).toBe(201);
      expect(res.body.projectPath).toBe(repoPath);
      expect(res.body.workspace).toBe(repoPath);
      expect(res.body.baseBranch).toBe('main');
      expect(res.body.worktreePath).toBeNull();
      expect(res.body.branch).toBeNull();
      await waitForIdle(app, res.body.id);
    });

    it('POST /api/sessions creates worktree metadata when requested', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/sessions')
        .send({
          prompt: 'Add workspace support',
          projectPath: repoPath,
          baseBranch: 'main',
          useWorktree: true,
        });

      expect(res.status).toBe(201);
      expect(res.body.workspace).toBeNull();
      expect(res.body.worktreePath).toBe(join(workspacesDir, res.body.id));
      expect(res.body.branch).toBe(`nuncio/${res.body.id}-add-workspace-support`);
      await waitForIdle(app, res.body.id);
    });
  });
});

async function waitForIdle(app: INestApplication, id: string, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await request(app.getHttpServer()).get(`/api/sessions/${id}`);
    if (res.body.status === 'IDLE' || res.body.status === 'ERROR') return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Session ${id} did not reach IDLE in time`);
}
