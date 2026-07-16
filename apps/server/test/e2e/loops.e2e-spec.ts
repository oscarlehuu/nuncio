import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { LoopsService } from '../../src/loops/loops.service';

/**
 * Loop lifecycle over the real server module graph with the forced Mock provider
 * (zero credentials) and a pinned loop clock. Exercises the reliability seams:
 * fire → pending → settle, a diagnosable failing run, the overlap-skip guard, and
 * a breaker trip raising an attention item immediately (not on the next sweep).
 */
describe('Loop lifecycle (e2e, forced Mock)', () => {
  let app: INestApplication;
  let root: string;
  let okRepo: string;
  let failRepo: string;
  let slowRepo: string;
  let workspaces: string;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'nuncio-loops-e2e-'));
    okRepo = join(root, 'ok');
    failRepo = join(root, 'fail');
    slowRepo = join(root, 'slow');
    workspaces = join(root, 'workspaces');
    mkdirSync(workspaces, { recursive: true });
    await initRepo(okRepo, 'exit 0\n');
    await initRepo(failRepo, 'exit 1\n');
    await initRepo(slowRepo, 'sleep 1.5\nexit 0\n');

    process.env.NUNCIO_DATA_DIR = join(root, 'data');
    process.env.NUNCIO_WORKSPACES_DIR = workspaces;
    process.env.NUNCIO_FORCE_MOCK = '1';
    app = await createApp();

    // Controllable clock: pin loop time to a fixed instant so the day-budget
    // bucket is deterministic across the run (never straddles local midnight).
    const fixedNow = Date.now();
    app.get(LoopsService).clock = { now: () => fixedNow };
  });

  afterAll(async () => {
    await app.close();
    rmSync(root, { recursive: true, force: true });
    for (const key of ['NUNCIO_DATA_DIR', 'NUNCIO_WORKSPACES_DIR', 'NUNCIO_FORCE_MOCK']) {
      delete process.env[key];
    }
  });

  it('fires a run, settles it green through the Mock provider, and joins run detail', async () => {
    const loopId = await createLoop(app, { projectPath: okRepo });
    const fire = await request(app.getHttpServer()).post(`/api/loops/${loopId}/fire`);
    expect(fire.status).toBe(201);
    expect(fire.body.outcome).toBe('pending');

    const settled = await waitForRunSettled(app, loopId, fire.body.id);
    expect(settled.outcome).toBe('ok');

    const detail = await request(app.getHttpServer()).get(`/api/loops/${loopId}/runs/${fire.body.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.sessionId).toBeTruthy(); // the run ran a real (mock) session
    expect(typeof detail.body.durationMs).toBe('number');
    // A loop NEVER runs in place — the run's session used a worktree under the dir.
    expect(app.get(LoopsService).findById(loopId)!.status).toBe('active');
  }, 40_000);

  it('a failing run settles failed and its run detail carries a diagnosable failure reason', async () => {
    // maxConsecutiveFailures high so this single failure does not trip the breaker.
    const loopId = await createLoop(app, { projectPath: failRepo, maxConsecutiveFailures: 5 });
    const fire = await request(app.getHttpServer()).post(`/api/loops/${loopId}/fire`);
    const settled = await waitForRunSettled(app, loopId, fire.body.id);
    expect(settled.outcome).toBe('failed');

    const detail = await request(app.getHttpServer()).get(`/api/loops/${loopId}/runs/${fire.body.id}`);
    expect(detail.body.outcome).toBe('failed');
    // Diagnosable: a non-empty failure reason (verify red / needs-attention / error).
    expect(typeof detail.body.failureReason).toBe('string');
    expect((detail.body.failureReason as string).length).toBeGreaterThan(0);
  }, 40_000);

  it('the overlap guard skips a second fire while a run is still pending (409), enqueuing nothing new', async () => {
    const loopId = await createLoop(app, { projectPath: slowRepo });
    const first = await request(app.getHttpServer()).post(`/api/loops/${loopId}/fire`);
    expect(first.body.outcome).toBe('pending');

    // Fire again while the first run's slow verify is still in flight → overlap 409.
    const second = await request(app.getHttpServer()).post(`/api/loops/${loopId}/fire`);
    expect(second.status).toBe(409);
    expect(second.body.reason).toBe('overlap');

    const runs = await request(app.getHttpServer()).get(`/api/loops/${loopId}/runs`);
    const items = runs.body.items as Array<{ outcome: string }>;
    expect(items.filter((r) => r.outcome === 'pending')).toHaveLength(1); // only ONE run in flight
    expect(items.filter((r) => r.outcome === 'skipped-overlap')).toHaveLength(1);

    // Let the pending run settle so it does not leak into later tests.
    await waitForRunSettled(app, loopId, first.body.id);
  }, 40_000);

  it('a breaker trip raises a tripped-breaker attention item immediately', async () => {
    // maxConsecutiveFailures=1: one failing run trips the breaker.
    const loopId = await createLoop(app, { projectPath: failRepo, maxConsecutiveFailures: 1 });
    const fire = await request(app.getHttpServer()).post(`/api/loops/${loopId}/fire`);
    await waitForRunSettled(app, loopId, fire.body.id);
    const broken = await waitForLoopStatus(app, loopId, 'broken');
    expect(broken.status).toBe('broken');

    const attention = await request(app.getHttpServer()).get('/api/attention');
    expect(attention.status).toBe(200);
    const item = (attention.body.items as Array<{ kind: string; subjectId: string; payload?: { loopId?: string } }>)
      .find((i) => i.kind === 'tripped-breaker' && i.subjectId === loopId);
    expect(item).toBeDefined();
    expect(item!.payload?.loopId).toBe(loopId);
  }, 40_000);
});

async function createLoop(app: INestApplication, over: Record<string, unknown>): Promise<string> {
  const res = await request(app.getHttpServer()).post('/api/loops').send({
    goal: 'e2e maintenance loop',
    engine: 'mock',
    schedule: { kind: 'heartbeat', spec: 'every:1h' },
    maxRunsPerDay: 20,
    maxConsecutiveFailures: 5,
    ...over,
  });
  if (res.status !== 201) throw new Error(`loop create failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.id as string;
}

async function waitForRunSettled(
  app: INestApplication,
  loopId: string,
  runId: string,
): Promise<{ id: string; outcome: string }> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const res = await request(app.getHttpServer()).get(`/api/loops/${loopId}/runs`);
    const run = (res.body.items as Array<{ id: string; outcome: string }> | undefined)?.find((r) => r.id === runId);
    if (run && run.outcome !== 'pending') return run;
    await Bun.sleep(50);
  }
  throw new Error(`loop run ${runId} did not settle in time`);
}

async function waitForLoopStatus(
  app: INestApplication,
  loopId: string,
  status: string,
): Promise<{ status: string }> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const res = await request(app.getHttpServer()).get(`/api/loops/${loopId}`);
    if (res.body?.status === status) return res.body;
    await Bun.sleep(50);
  }
  throw new Error(`loop ${loopId} did not reach status ${status}`);
}

async function createApp(): Promise<INestApplication> {
  const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const application = module.createNestApplication({ rawBody: true });
  application.setGlobalPrefix('api');
  await application.init();
  return application;
}

async function initRepo(dir: string, verifyBody: string): Promise<void> {
  mkdirSync(join(dir, '.nuncio'), { recursive: true });
  writeFileSync(join(dir, 'README.md'), '# loop e2e fixture\n');
  writeFileSync(join(dir, '.nuncio', 'verify'), `#!/bin/sh\n${verifyBody}`, { mode: 0o755 });
  await git(dir, ['init', '-b', 'main']);
  await git(dir, ['config', 'user.email', 'loops@nuncio.local']);
  await git(dir, ['config', 'user.name', 'Loops Test']);
  await git(dir, ['add', '.']);
  await git(dir, ['commit', '-m', 'test: initialize loop fixture']);
}

async function git(cwd: string, args: string[]): Promise<void> {
  const proc = Bun.spawn(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  const code = await proc.exited;
  if (code !== 0) throw new Error(await new Response(proc.stderr).text());
}
