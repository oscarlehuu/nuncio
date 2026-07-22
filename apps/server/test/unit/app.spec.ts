import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AppModule } from '../../src/app.module';
import { DatabaseService } from '../../src/db/database.service';
import { PiAgentProvider } from '../../src/agents/providers/pi-agent.provider';
import { SessionsRepository } from '../../src/sessions/persistence/sessions.repository';
import {
  configureSimulatedCursorEnv,
  withSimulatedCursorProvider,
} from '../helpers/simulated-cursor-app';
import { stubAgentProvider } from '../helpers/stub-agent-provider';

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

function api(app: INestApplication) {
  return request(app.getHttpAdapter().getInstance());
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
    // This HTTP suite drives the simulated Cursor engine as its default, so the
    // legacy engines are shown here.
    process.env.NUNCIO_ENGINES_SHOW_LEGACY = '1';
    configureSimulatedCursorEnv();
    process.env.NUNCIO_PROJECT_ROOTS = rootsDir;
    process.env.NUNCIO_WORKSPACES_DIR = workspacesDir;

    const moduleFixture: TestingModule = await withSimulatedCursorProvider(
      Test.createTestingModule({
        imports: [AppModule],
      }),
    )
      // Pin pi unavailable so the implicit default stays on the simulated
      // cursor engine regardless of the developer machine's pi credentials.
      .overrideProvider(PiAgentProvider)
      .useValue(stubAgentProvider('pi', 'Nuncio Engine', false))
      .compile();

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
    delete process.env.NUNCIO_ENGINES_SHOW_LEGACY;
    delete process.env.NUNCIO_PROJECT_ROOTS;
    delete process.env.NUNCIO_WORKSPACES_DIR;
  });

  it('GET /api/health returns ok', async () => {
    const res = await api(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  it('GET /api/timeline returns the global timeline feed', async () => {
    const res = await api(app).get('/api/timeline?limit=5');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.entries)).toBe(true);
    expect(res.body.entries.length).toBeLessThanOrEqual(5);
  });

  it('POST /api/sessions creates a session', async () => {
    const res = await api(app)
      .post('/api/sessions')
      .send({ prompt: 'Fix the flaky websocket test' });

    expect(res.status).toBe(201);
    expect(res.body.id).toBeDefined();
    expect(res.body.status).toBe('CREATED');
    expect(res.body.title).toContain('websocket');
  });

  it('GET /api/sessions lists sessions', async () => {
    const res = await api(app).get('/api/sessions');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);
  });

  it('GET /api/sessions tolerates sessions from an unregistered provider', async () => {
    const repo = app.get(SessionsRepository);
    const ghost = repo.create({
      id: 'ghost-open',
      prompt: 'stale test run',
      provider: 'ghost-provider',
    });

    const res = await api(app).get('/api/sessions');

    expect(res.status).toBe(200);
    const listed = res.body.find((s: { id: string }) => s.id === ghost.id);
    expect(listed).toMatchObject({
      id: ghost.id,
      provider: 'ghost-provider',
      providerAvailable: false,
      supportsInteraction: false,
      supportsInterrupt: false,
      supportsSteerWhileRunning: false,
      supportsImages: false,
    });
  });

  it('GET /api/sessions?includeArchived=true tolerates archived sessions from an unregistered provider', async () => {
    const repo = app.get(SessionsRepository);
    const db = app.get(DatabaseService).db;
    const ghost = repo.create({
      id: 'ghost-archived',
      prompt: 'archived stale test run',
      provider: 'ghost-provider',
    });
    db.prepare("UPDATE sessions SET status = 'ARCHIVED' WHERE id = ?").run(ghost.id);

    const hidden = await api(app).get('/api/sessions');
    expect(hidden.status).toBe(200);
    expect(hidden.body.some((s: { id: string }) => s.id === ghost.id)).toBe(false);

    const res = await api(app).get('/api/sessions?includeArchived=true');

    expect(res.status).toBe(200);
    const listed = res.body.find((s: { id: string }) => s.id === ghost.id);
    expect(listed).toMatchObject({
      id: ghost.id,
      status: 'ARCHIVED',
      provider: 'ghost-provider',
      providerAvailable: false,
    });
  });

  it('POST /api/sessions/:id/steer still rejects sessions from an unregistered provider', async () => {
    const repo = app.get(SessionsRepository);
    const ghost = repo.create({
      id: 'ghost-action',
      prompt: 'action needs provider',
      provider: 'ghost-provider',
    });

    const res = await api(app)
      .post(`/api/sessions/${ghost.id}/steer`)
      .send({ message: 'resume this' });

    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Unknown agent provider ghost-provider');
  });

  it('GET /api/sessions/:id/events returns events after run', async () => {
    const created = await api(app)
      .post('/api/sessions')
      .send({ prompt: 'Write a hello world script' });

    const id = created.body.id;
    await waitForIdle(app, id);

    const res = await api(app).get(`/api/sessions/${id}/events`);
    expect(res.status).toBe(200);
    expect(res.body.some((e: { type: string }) => e.type === 'user_message')).toBe(true);
    expect(res.body.some((e: { type: string }) => e.type === 'assistant_message')).toBe(true);
  });

  describe('phase 3 session lifecycle', () => {
    it('POST /api/sessions/:id/steer succeeds when IDLE', async () => {
      const created = await api(app)
        .post('/api/sessions')
        .send({ prompt: 'Build the auth module' });

      const id = created.body.id;
      await waitForIdle(app, id);

      const steer = await api(app)
        .post(`/api/sessions/${id}/steer`)
        .send({ message: 'Focus on unit tests only' });

      expect(steer.status).toBe(201);
      await waitForIdle(app, id);

      const events = await api(app).get(`/api/sessions/${id}/events`);
      expect(events.body.some((e: { type: string }) => e.type === 'steer_message')).toBe(true);
    });

    it('POST /api/sessions/:id/steer succeeds when PAUSED', async () => {
      const created = await api(app)
        .post('/api/sessions')
        .send({ prompt: 'Refactor the session store' });

      const id = created.body.id;
      await waitForIdle(app, id);

      const paused = await api(app).post(`/api/sessions/${id}/pause`);
      expect(paused.status).toBe(201);
      expect(paused.body.status).toBe('PAUSED');

      const steer = await api(app)
        .post(`/api/sessions/${id}/steer`)
        .send({ message: 'Resume with integration tests' });

      expect(steer.status).toBe(201);
      await waitForIdle(app, id);
      expect((await api(app).get(`/api/sessions/${id}`)).body.status).toBe('IDLE');
    });

    it('POST /api/sessions/:id/archive transitions to ARCHIVED', async () => {
      const created = await api(app)
        .post('/api/sessions')
        .send({ prompt: 'Archive me when done' });

      const id = created.body.id;
      await waitForIdle(app, id);

      const archived = await api(app).post(`/api/sessions/${id}/archive`);
      expect(archived.status).toBe(201);
      expect(archived.body.status).toBe('ARCHIVED');
    });

    it('PATCH /api/sessions/:id renames the session', async () => {
      const created = await api(app)
        .post('/api/sessions')
        .send({ prompt: 'Original title' });
      const id = created.body.id;
      await waitForIdle(app, id);

      const renamed = await api(app)
        .patch(`/api/sessions/${id}`)
        .send({ title: 'My custom name' });
      expect(renamed.status).toBe(200);
      expect(renamed.body.title).toBe('My custom name');
      expect(renamed.body.id).toBe(id);
    });

    it('PATCH /api/sessions/:id rejects empty title', async () => {
      const created = await api(app)
        .post('/api/sessions')
        .send({ prompt: 'Some prompt' });
      const id = created.body.id;

      const res = await api(app)
        .patch(`/api/sessions/${id}`)
        .send({ title: '   ' });
      expect(res.body.error).toBeDefined();
    });

    it('GET /api/sessions excludes archived sessions', async () => {
      const created = await api(app)
        .post('/api/sessions')
        .send({ prompt: 'Hidden after archive' });

      const id = created.body.id;
      await waitForIdle(app, id);
      await api(app).post(`/api/sessions/${id}/archive`);

      const list = await api(app).get('/api/sessions');
      expect(list.status).toBe(200);
      expect(list.body.some((s: { id: string }) => s.id === id)).toBe(false);

      const withArchived = await api(app).get('/api/sessions?includeArchived=true');
      expect(withArchived.body.some((s: { id: string; status: string }) => s.id === id && s.status === 'ARCHIVED')).toBe(
        true,
      );
    });
  });

  it('POST /api/sessions/:id/interactions/:requestId/respond returns 501 for cursor sessions', async () => {
    const created = await api(app)
      .post('/api/sessions')
      .send({ prompt: 'Ask me something' });
    const id = created.body.id;
    await waitForIdle(app, id);

    const res = await api(app)
      .post(`/api/sessions/${id}/interactions/req-1/respond`)
      .send({ answers: [], resolvedBy: 'skip' });

    expect(res.status).toBe(501);
    expect(res.body.error).toContain('does not support live interaction respond');
  });

  describe('phase 4 workspace integration', () => {
    it('GET /api/projects lists git repos from configured roots', async () => {
      const res = await api(app).get('/api/projects');
      expect(res.status).toBe(200);
      expect(res.body.some((project: { path: string }) => project.path === repoPath)).toBe(true);
    });

    it('GET /api/projects/branches returns branches for a repo path', async () => {
      const res = await api(app).get(`/api/projects/branches?path=${encodeURIComponent(repoPath)}`);
      expect(res.status).toBe(200);
      expect(res.body.some((branch: { name: string }) => branch.name === 'main')).toBe(true);
    });

    it('GET /api/projects/branches?refresh=1 still returns local branches', async () => {
      const res = await api(app).get(
        `/api/projects/branches?path=${encodeURIComponent(repoPath)}&refresh=1`,
      );
      expect(res.status).toBe(200);
      expect(res.body.some((branch: { name: string }) => branch.name === 'main')).toBe(true);
    });

    it('POST /api/sessions with projectPath defaults to the selected workspace', async () => {
      const res = await api(app)
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
      const res = await api(app)
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
    const res = await api(app).get(`/api/sessions/${id}`);
    if (res.body.status === 'IDLE' || res.body.status === 'ERROR') return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Session ${id} did not reach IDLE in time`);
}
