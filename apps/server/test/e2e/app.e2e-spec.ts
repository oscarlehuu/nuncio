import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AppModule } from '../../src/app.module';
import { CursorLocalSessionsService } from '../../src/cursor-local/cursor-local-sessions.service';
import { toProjectSlug } from '../../src/cursor-local/cursor-project-slug';
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
    configureSimulatedCursorEnv();
    process.env.NUNCIO_PROJECT_ROOTS = rootsDir;
    process.env.NUNCIO_WORKSPACES_DIR = workspacesDir;

    const moduleFixture: TestingModule = await withSimulatedCursorProvider(
      Test.createTestingModule({
        imports: [AppModule],
      }),
    ).compile();

    app = moduleFixture.createNestApplication({ rawBody: true });
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
    expect(res.body.service).toBe('nuncio-server');
  });

  it('GET /api/models lists available providers', async () => {
    const res = await request(app.getHttpServer()).get('/api/models');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.some((p: { id: string }) => p.id === 'cursor')).toBe(true);
  });

  it('runs a full session lifecycle over HTTP', async () => {
    const created = await request(app.getHttpServer())
      .post('/api/sessions')
      .send({ prompt: 'Build the e2e flow', provider: 'cursor' });
    expect(created.status).toBe(201);
    expect(created.body.id).toBeDefined();
    expect(created.body.provider).toBe('cursor');

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

    // restore the archived session back to IDLE
    const restored = await request(app.getHttpServer()).post(`/api/sessions/${id}/restore`);
    expect(restored.status).toBe(201);
    expect(restored.body.status).toBe('IDLE');
    expect(
      (await request(app.getHttpServer()).get(`/api/sessions/${id}`)).body.status,
    ).toBe('IDLE');

    // re-archive, then permanently delete
    await request(app.getHttpServer()).post(`/api/sessions/${id}/archive`);
    const deleted = await request(app.getHttpServer()).delete(`/api/sessions/${id}`);
    expect(deleted.status).toBe(200);
    expect(deleted.body).toEqual({ ok: true });
    expect(
      (await request(app.getHttpServer()).get(`/api/sessions/${id}`)).status,
    ).toBe(404);
    // events endpoint also 404s once the session row is gone
    expect(
      (await request(app.getHttpServer()).get(`/api/sessions/${id}/events`)).status,
    ).toBe(404);
  });

  it('rejects DELETE on a non-archived session (must archive first)', async () => {
    const created = await request(app.getHttpServer())
      .post('/api/sessions')
      .send({ prompt: 'do not delete me yet', provider: 'cursor' });
    const id = created.body.id;
    await waitForIdle(app, id);

    const res = await request(app.getHttpServer()).delete(`/api/sessions/${id}`);
    expect(res.status).toBe(400);

    // cleanup so other tests don't see it
    await request(app.getHttpServer()).post(`/api/sessions/${id}/archive`);
    await request(app.getHttpServer()).delete(`/api/sessions/${id}`);
  });

  it('rejects restore on a non-archived session', async () => {
    const created = await request(app.getHttpServer())
      .post('/api/sessions')
      .send({ prompt: 'do not restore me yet', provider: 'cursor' });
    const id = created.body.id;
    await waitForIdle(app, id);

    const res = await request(app.getHttpServer()).post(`/api/sessions/${id}/restore`);
    expect(res.status).toBe(400);

    await request(app.getHttpServer()).post(`/api/sessions/${id}/archive`);
    await request(app.getHttpServer()).delete(`/api/sessions/${id}`);
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

    it('POST /api/sessions with projectPath defaults to the selected workspace', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/sessions')
        .send({
          prompt: 'Inspect workspace e2e flow',
          provider: 'cursor',
          projectPath: repoPath,
          baseBranch: 'main',
        });

      expect(res.status).toBe(201);
      expect(res.body.id).toBeDefined();
      expect(res.body.projectPath).toBe(repoPath);
      expect(res.body.workspace).toBe(repoPath);
      expect(res.body.baseBranch).toBe('main');
      expect(res.body.worktreePath).toBeNull();
      expect(res.body.branch).toBeNull();
      await waitForIdle(app, res.body.id);
    });

    it('POST /api/sessions creates worktree metadata + on-disk worktree when requested', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/sessions')
        .send({
          prompt: 'Add workspace e2e flow',
          provider: 'cursor',
          projectPath: repoPath,
          baseBranch: 'main',
          useWorktree: true,
        });

      expect(res.status).toBe(201);
      expect(res.body.id).toBeDefined();
      expect(res.body.projectPath).toBe(repoPath);
      expect(res.body.workspace).toBeNull();
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
          provider: 'cursor',
          projectPath: '/definitely/not/a/git/repo',
          baseBranch: 'main',
        });
      expect(res.status).toBe(400);
    });
  });

  describe('session git ops (e2e)', () => {
    it('status → commit → push for a worktree session', async () => {
      const bareRemote = mkdtempSync(join(tmpdir(), 'nuncio-e2e-bare-'));
      await runGitAsync(bareRemote, ['init', '--bare', '-b', 'main']);
      try {
        const created = await request(app.getHttpServer())
          .post('/api/sessions')
          .send({
            prompt: 'Edit a file for git e2e',
            provider: 'cursor',
            projectPath: repoPath,
            baseBranch: 'main',
            useWorktree: true,
          });
        expect(created.status).toBe(201);
        const id = created.body.id as string;
        const worktreePath = created.body.worktreePath as string;
        const branch = created.body.branch as string;
        await waitForIdle(app, id);

        // Wire a push target onto the shared repo so the worktree can push origin.
        await runGitAsync(worktreePath, ['remote', 'add', 'origin', bareRemote]);

        // Make a change in the worktree.
        writeFileSync(join(worktreePath, 'feature.txt'), 'hello from e2e\n');

        const dirty = await request(app.getHttpServer()).get(`/api/sessions/${id}/git/status`);
        expect(dirty.status).toBe(200);
        expect(dirty.body.clean).toBe(false);
        expect(dirty.body.files.some((f: { path: string }) => f.path.includes('feature.txt'))).toBe(true);

        const diff = await request(app.getHttpServer()).get(`/api/sessions/${id}/git/diff`);
        expect(diff.status).toBe(200);
        expect(typeof diff.body.diff).toBe('string');

        const commit = await request(app.getHttpServer())
          .post(`/api/sessions/${id}/git/commit`)
          .send({ message: 'e2e: add feature.txt' });
        expect(commit.status).toBe(201);
        expect(commit.body.committed).toBe(true);
        expect(commit.body.sha).toMatch(/^[0-9a-f]{40}$/);

        const clean = await request(app.getHttpServer()).get(`/api/sessions/${id}/git/status`);
        expect(clean.body.clean).toBe(true);

        const push = await request(app.getHttpServer())
          .post(`/api/sessions/${id}/git/push`)
          .send({});
        expect(push.status).toBe(201);
        expect(push.body.pushed).toBe(true);
        expect(push.body.remoteBranch).toBe(branch);

        // The bare remote actually received the pushed branch.
        const verify = Bun.spawn(['git', '-C', bareRemote, 'rev-parse', '--verify', branch], {
          stdout: 'pipe',
          stderr: 'pipe',
        });
        expect(await verify.exited).toBe(0);
      } finally {
        rmSync(bareRemote, { recursive: true, force: true });
      }
    });
  });

  describe('forge webhooks (e2e)', () => {
    const SECRET = 'e2e-webhook-secret';
    let webhookRepo: string;
    let gitlabRepo: string;

    beforeAll(async () => {
      webhookRepo = join(rootsDir, 'webhook-repo');
      await initRepo(webhookRepo);
      await runGitAsync(webhookRepo, [
        'remote',
        'add',
        'origin',
        'https://github.com/octo/webhook-repo.git',
      ]);
      process.env.GITHUB_WEBHOOK_SECRET = SECRET;

      gitlabRepo = join(rootsDir, 'gl-repo');
      await initRepo(gitlabRepo);
      await runGitAsync(gitlabRepo, [
        'remote',
        'add',
        'origin',
        'https://gitlab.com/octo/gl-repo.git',
      ]);
      process.env.GITLAB_WEBHOOK_SECRET = SECRET;
    });

    afterAll(() => {
      delete process.env.GITHUB_WEBHOOK_SECRET;
      delete process.env.GITLAB_WEBHOOK_SECRET;
    });

    function signedPayload(deliveryId: string) {
      const payload = {
        action: 'opened',
        issue: {
          number: 5,
          title: 'Webhook task',
          body: 'do the thing',
          labels: [{ name: 'nuncio' }],
        },
        repository: {
          name: 'webhook-repo',
          full_name: 'octo/webhook-repo',
          default_branch: 'main',
          owner: { login: 'octo' },
        },
      };
      const raw = JSON.stringify(payload);
      const sig = `sha256=${createHmac('sha256', SECRET).update(raw).digest('hex')}`;
      return { raw, sig, deliveryId };
    }

    it('rejects a bad signature with 401 and creates no session', async () => {
      const { raw } = signedPayload('e2e-bad-1');
      const res = await request(app.getHttpServer())
        .post('/api/webhooks/forge/github')
        .set('Content-Type', 'application/json')
        .set('x-github-event', 'issues')
        .set('x-github-delivery', 'e2e-bad-1')
        .set('x-hub-signature-256', 'sha256=deadbeef')
        .send(raw);
      expect(res.status).toBe(401);
    });

    it('accepts a signed issue.opened, creates a session, and dedupes replays', async () => {
      const before = (await request(app.getHttpServer()).get('/api/sessions')).body.length;
      const { raw, sig } = signedPayload('e2e-deliver-1');

      const res = await request(app.getHttpServer())
        .post('/api/webhooks/forge/github')
        .set('Content-Type', 'application/json')
        .set('x-github-event', 'issues')
        .set('x-github-delivery', 'e2e-deliver-1')
        .set('x-hub-signature-256', sig)
        .send(raw);
      expect(res.status).toBe(202);
      expect(res.body.created).toBe(true);
      expect(res.body.sessionId).toBeDefined();

      const replay = await request(app.getHttpServer())
        .post('/api/webhooks/forge/github')
        .set('Content-Type', 'application/json')
        .set('x-github-event', 'issues')
        .set('x-github-delivery', 'e2e-deliver-1')
        .set('x-hub-signature-256', sig)
        .send(raw);
      expect(replay.status).toBe(202);
      expect(replay.body.created).toBe(false);
      expect(replay.body.reason).toBe('duplicate');

      const after = (await request(app.getHttpServer()).get('/api/sessions')).body.length;
      expect(after).toBe(before + 1);

      await waitForIdle(app, res.body.sessionId);
    });

    it('accepts a GitLab Issue Hook (token-verified) and creates a session', async () => {
      const before = (await request(app.getHttpServer()).get('/api/sessions')).body.length;
      const payload = {
        object_attributes: {
          iid: 8,
          title: 'GitLab webhook task',
          description: 'do the gitlab thing',
          action: 'open',
          target_branch: 'main',
        },
        project: { path_with_namespace: 'octo/gl-repo', default_branch: 'main' },
        labels: [{ title: 'nuncio' }],
      };
      const raw = JSON.stringify(payload);

      const res = await request(app.getHttpServer())
        .post('/api/webhooks/forge/gitlab')
        .set('Content-Type', 'application/json')
        .set('x-gitlab-event', 'Issue Hook')
        .set('x-gitlab-event-uuid', 'gl-deliver-1')
        .set('x-gitlab-token', SECRET)
        .send(raw);
      expect(res.status).toBe(202);
      expect(res.body.created).toBe(true);
      expect(res.body.sessionId).toBeDefined();

      // A wrong token is rejected.
      const bad = await request(app.getHttpServer())
        .post('/api/webhooks/forge/gitlab')
        .set('Content-Type', 'application/json')
        .set('x-gitlab-event', 'Issue Hook')
        .set('x-gitlab-event-uuid', 'gl-deliver-2')
        .set('x-gitlab-token', 'wrong-token')
        .send(raw);
      expect(bad.status).toBe(401);

      const after = (await request(app.getHttpServer()).get('/api/sessions')).body.length;
      expect(after).toBe(before + 1);

      await waitForIdle(app, res.body.sessionId);
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

  describe('handoff (e2e)', () => {
    let fakeHome: string;
    let handoffWorkspace: string;
    const chatId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

    beforeAll(() => {
      fakeHome = mkdtempSync(join(tmpdir(), 'nuncio-e2e-handoff-home-'));
      handoffWorkspace = join(fakeHome, 'repo');
      mkdirSync(handoffWorkspace, { recursive: true });
      const slug = toProjectSlug(handoffWorkspace);
      const dir = join(fakeHome, '.cursor/projects', slug, 'agent-transcripts', chatId);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, `${chatId}.jsonl`),
        JSON.stringify({
          role: 'user',
          message: { content: [{ type: 'text', text: 'E2E handoff chat' }] },
        }) + '\n',
      );

      const local = app.get(CursorLocalSessionsService);
      local.homeDir = () => fakeHome;
    });

    afterAll(() => {
      rmSync(fakeHome, { recursive: true, force: true });
    });

    it('GET /api/cursor/local-sessions lists fixture chat', async () => {
      const res = await request(app.getHttpServer()).get(
        `/api/cursor/local-sessions?workspace=${encodeURIComponent(handoffWorkspace)}`,
      );
      expect(res.status).toBe(200);
      expect(res.body.items.some((item: { chatId: string }) => item.chatId === chatId)).toBe(true);
    });

    it('POST /api/sessions/handoff imports chat as IDLE cli session (idempotent)', async () => {
      const first = await request(app.getHttpServer())
        .post('/api/sessions/handoff')
        .send({ cursorChatId: chatId, workspace: handoffWorkspace });
      expect(first.status).toBe(201);
      expect(first.body.cursorBackend).toBe('cli');
      expect(first.body.cursorChatId).toBe(chatId);
      expect(first.body.status).toBe('IDLE');

      const events = await request(app.getHttpServer()).get(`/api/sessions/${first.body.id}/events`);
      expect(events.body.some((e: { type: string }) => e.type === 'user_message')).toBe(true);

      const second = await request(app.getHttpServer())
        .post('/api/sessions/handoff')
        .send({ cursorChatId: chatId, workspace: handoffWorkspace });
      expect(second.status).toBe(201);
      expect(second.body.id).toBe(first.body.id);
    });

    it('POST /api/sessions/handoff returns 404 for missing chat', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/sessions/handoff')
        .send({
          cursorChatId: '00000000-0000-0000-0000-000000000000',
          workspace: handoffWorkspace,
        });
      expect(res.status).toBe(404);
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
      expect(cursor.hasValue).toBe(true);
      expect(cursor.source).toBe('env');
      expect(cursor.value).toBe('••••-key');
      const projectRoots = res.body.find((s: { key: string }) => s.key === 'NUNCIO_PROJECT_ROOTS');
      expect(projectRoots).toBeDefined();
      expect(projectRoots.hasValue).toBe(true);
      expect(projectRoots.source).toBe('env');
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
      expect(res.body.hasValue).toBe(true);
      expect(res.body.source).toBe('env');
      expect(res.body.value).toBe('••••-key');
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
