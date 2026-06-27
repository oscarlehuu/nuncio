import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AppModule } from '../../src/app.module';

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
  writeFileSync(join(dir, 'README.md'), '# e2e test\n');
  await runGitAsync(dir, ['add', 'README.md']);
  await runGitAsync(dir, ['config', 'user.email', 'test@nuncio.local']);
  await runGitAsync(dir, ['config', 'user.name', 'Nuncio Test']);
  await runGitAsync(dir, ['commit', '-m', 'init']);
}

describe('Nuncio API (e2e)', () => {
  let app: INestApplication;
  let dataDir: string;
  let rootsDir: string;
  let repoPath: string;
  let workspacesDir: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-e2e-'));
    rootsDir = mkdtempSync(join(tmpdir(), 'nuncio-e2e-roots-'));
    repoPath = join(rootsDir, 'e2e-repo');
    workspacesDir = mkdtempSync(join(tmpdir(), 'nuncio-e2e-ws-'));
    await initRepo(repoPath);

    process.env.NUNCIO_DATA_DIR = dataDir;
    process.env.NUNCIO_FORCE_MOCK = '1';
    process.env.NUNCIO_PROJECT_ROOTS = rootsDir;
    process.env.NUNCIO_WORKSPACES_DIR = workspacesDir;

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

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
    delete process.env.NUNCIO_FORCE_MOCK;
    delete process.env.NUNCIO_PROJECT_ROOTS;
    delete process.env.NUNCIO_WORKSPACES_DIR;
  });

  it('GET /api/health returns ok', async () => {
    const res = await request(app.getHttpServer()).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.service).toBe('nuncio-server');
  });

  it('GET /api/models lists available providers', async () => {
    const res = await request(app.getHttpServer()).get('/api/models');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.some((p: { id: string }) => p.id === 'mock')).toBe(true);
  });

  it('runs a full session lifecycle over HTTP', async () => {
    const created = await request(app.getHttpServer())
      .post('/api/sessions')
      .send({ prompt: 'Build the e2e flow', provider: 'mock' });
    expect(created.status).toBe(201);
    expect(created.body.id).toBeDefined();
    expect(created.body.provider).toBe('mock');

    const id = created.body.id;
    await waitForIdle(app, id);

    const events = await request(app.getHttpServer()).get(`/api/sessions/${id}/events`);
    expect(events.status).toBe(200);
    expect(events.body.some((e: { type: string }) => e.type === 'user_message')).toBe(true);
    expect(events.body.some((e: { type: string }) => e.type === 'assistant_message')).toBe(true);

    const steer = await request(app.getHttpServer())
      .post(`/api/sessions/${id}/steer`)
      .send({ message: 'now focus on tests' });
    expect(steer.status).toBe(201);
    await waitForIdle(app, id);
    expect((await request(app.getHttpServer()).get(`/api/sessions/${id}`)).body.status).toBe('IDLE');

    const paused = await request(app.getHttpServer()).post(`/api/sessions/${id}/pause`);
    expect(paused.status).toBe(201);
    expect(paused.body.status).toBe('PAUSED');

    const archived = await request(app.getHttpServer()).post(`/api/sessions/${id}/archive`);
    expect(archived.status).toBe(201);
    expect(archived.body.status).toBe('ARCHIVED');
  });

  it('rejects creating a session with an unknown provider', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/sessions')
      .send({ prompt: 'bad provider', provider: 'missing' });
    expect(res.status).toBe(400);
  });

  describe('phase 4 workspace (e2e)', () => {
    it('GET /api/projects lists git repos from configured roots', async () => {
      const res = await request(app.getHttpServer()).get('/api/projects');
      expect(res.status).toBe(200);
      expect(res.body.some((p: { path: string }) => p.path === repoPath)).toBe(true);
    });

    it('GET /api/projects/branches returns branches for a repo path', async () => {
      const res = await request(app.getHttpServer()).get(
        `/api/projects/branches?path=${encodeURIComponent(repoPath)}`,
      );
      expect(res.status).toBe(200);
      expect(res.body.some((b: { name: string }) => b.name === 'main')).toBe(true);
    });

    it('POST /api/sessions with projectPath creates worktree metadata + on-disk worktree', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/sessions')
        .send({
          prompt: 'Add workspace e2e flow',
          provider: 'mock',
          projectPath: repoPath,
          baseBranch: 'main',
        });

      expect(res.status).toBe(201);
      expect(res.body.id).toBeDefined();
      expect(res.body.projectPath).toBe(repoPath);
      expect(res.body.baseBranch).toBe('main');
      expect(res.body.worktreePath).toBe(join(workspacesDir, res.body.id));
      expect(res.body.branch).toBe(`nuncio/${res.body.id}-add-workspace-e2e-flow`);

      // The worktree directory must actually exist on disk.
      const stat = Bun.spawn(['stat', '-t', res.body.worktreePath], { stdout: 'pipe', stderr: 'pipe' });
      expect(await stat.exited).toBe(0);

      // The worktree must be checked out to the nuncio branch.
      const branchProc = Bun.spawn(
        ['git', '-C', res.body.worktreePath, 'rev-parse', '--abbrev-ref', 'HEAD'],
        { stdout: 'pipe', stderr: 'pipe' },
      );
      const branch = (await new Response(branchProc.stdout).text()).trim();
      expect(branch).toBe(res.body.branch);

      await waitForIdle(app, res.body.id);
    });

    it('rejects POST /api/sessions with a non-git projectPath', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/sessions')
        .send({
          prompt: 'broken workspace',
          provider: 'mock',
          projectPath: '/definitely/not/a/git/repo',
          baseBranch: 'main',
        });
      expect(res.status).toBe(400);
    });
  });

  describe('fs directory browser (e2e)', () => {
    it('GET /api/fs/dirs defaults to home and returns a listing', async () => {
      const res = await request(app.getHttpServer()).get('/api/fs/dirs');
      expect(res.status).toBe(200);
      expect(res.body.current).toBeDefined();
      expect(typeof res.body.current).toBe('string');
      expect(Array.isArray(res.body.entries)).toBe(true);
      // entries carry the documented shape
      if (res.body.entries.length > 0) {
        const first = res.body.entries[0];
        expect(first.name).toBeDefined();
        expect(first.path).toBeDefined();
        expect(typeof first.isGit).toBe('boolean');
      }
    });

    it('GET /api/fs/dirs?path= lists the given directory and reports parent', async () => {
      const res = await request(app.getHttpServer()).get(
        `/api/fs/dirs?path=${encodeURIComponent(repoPath)}`,
      );
      expect(res.status).toBe(200);
      expect(res.body.current).toBe(repoPath);
      expect(res.body.parent).toBeDefined();
      // e2e-repo is a git repo — it should self-report isGit on its own .git,
      // but listing its contents: a fresh repo has no non-hidden subdirs.
      expect(Array.isArray(res.body.entries)).toBe(true);
    });

    it('GET /api/fs/dirs returns 400 for a non-existent path', async () => {
      const res = await request(app.getHttpServer()).get(
        `/api/fs/dirs?path=${encodeURIComponent('/definitely/not/here')}`,
      );
      expect(res.status).toBe(400);
    });
  });

  describe('settings (e2e)', () => {
    it('GET /api/settings returns the catalog with masked secrets', async () => {
      const res = await request(app.getHttpServer()).get('/api/settings');
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      const cursor = res.body.find((s: { key: string }) => s.key === 'CURSOR_API_KEY');
      expect(cursor).toBeDefined();
      expect(cursor.type).toBe('secret');
      expect(cursor.hasValue).toBe(false);
      expect(cursor.value).toBeNull();
      // NUNCIO_FORCE_MOCK is set to '1' via env in beforeAll → hasValue true, raw (non-secret)
      const forceMock = res.body.find((s: { key: string }) => s.key === 'NUNCIO_FORCE_MOCK');
      expect(forceMock.hasValue).toBe(true);
      expect(forceMock.source).toBe('env');
      expect(forceMock.value).toBe('1');
    });

    it('PUT /api/settings/CURSOR_API_KEY stores + returns a masked DTO (never raw)', async () => {
      const res = await request(app.getHttpServer())
        .put('/api/settings/CURSOR_API_KEY')
        .send({ value: 'sk-e2e-secret-abcdef1234' });
      expect(res.status).toBe(200);
      expect(res.body.hasValue).toBe(true);
      expect(res.body.source).toBe('db');
      expect(res.body.value).toBe('••••1234'); // masked, last 4
      // The raw secret must never appear anywhere in the response body.
      expect(JSON.stringify(res.body)).not.toContain('sk-e2e-secret');
    });

    it('GET /api/settings/CURSOR_API_KEY after PUT shows masked value, not raw', async () => {
      const res = await request(app.getHttpServer()).get('/api/settings/CURSOR_API_KEY');
      expect(res.status).toBe(200);
      expect(res.body.hasValue).toBe(true);
      expect(res.body.value).toBe('••••1234');
      expect(JSON.stringify(res.body)).not.toContain('sk-e2e-secret');
    });

    it('PUT /api/settings rejects a missing value field with 400', async () => {
      const res = await request(app.getHttpServer())
        .put('/api/settings/CURSOR_API_KEY')
        .send({});
      expect(res.status).toBe(400);
    });

    it('GET /api/settings/:key returns 404 for an unknown key', async () => {
      const res = await request(app.getHttpServer()).get('/api/settings/NOPE');
      expect(res.status).toBe(404);
    });

    it('DELETE /api/settings/CURSOR_API_KEY clears the DB row (falls back to env/default)', async () => {
      const res = await request(app.getHttpServer()).delete('/api/settings/CURSOR_API_KEY');
      expect(res.status).toBe(200);
      expect(res.body.hasValue).toBe(false);
      expect(res.body.value).toBeNull();
    });
  });
});

async function waitForIdle(app: INestApplication, id: string, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await request(app.getHttpServer()).get(`/api/sessions/${id}`);
    if (res.body.status === 'IDLE' || res.body.status === 'ERROR') return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Session ${id} did not reach IDLE in time`);
}
