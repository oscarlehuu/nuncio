import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { GitService } from '../../src/git/git.service';
import type { CrewProfileSnapshot } from '../../src/crew/domain/crew.types';
import { CrewRunsRepository } from '../../src/crew/persistence/crew-runs.repository';
import { CrewTasksRepository } from '../../src/crew/persistence/crew-tasks.repository';
import { TasksService } from '../../src/tasks/tasks.service';
import { TasksRepository } from '../../src/tasks/tasks.repository';
import { CrewWriterLeaseService } from '../../src/crew/crew-writer-lease.service';

describe('Crew forced-Mock workflow (e2e)', () => {
  let app: INestApplication;
  let root: string;
  let repo: string;
  let slowRepo: string;
  let workspaces: string;
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'nuncio-crew-e2e-'));
    repo = join(root, 'repo');
    slowRepo = join(root, 'slow-repo');
    workspaces = join(root, 'workspaces');
    mkdirSync(join(repo, '.nuncio'), { recursive: true });
    mkdirSync(workspaces, { recursive: true });
    writeFileSync(join(repo, 'README.md'), '# Crew e2e\n');
    writeFileSync(join(repo, '.nuncio', 'verify'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    await git(repo, ['init', '-b', 'main']);
    await git(repo, ['config', 'user.email', 'crew@nuncio.local']);
    await git(repo, ['config', 'user.name', 'Crew Test']);
    await git(repo, ['add', '.']);
    await git(repo, ['commit', '-m', 'test: initialize Crew fixture']);
    mkdirSync(slowRepo, { recursive: true });
    writeFileSync(join(slowRepo, 'README.md'), '# Slow Crew e2e\n');
    writeFileSync(join(slowRepo, '.gitignore'), '.crew-verify-sentinel-*\n');
    await git(slowRepo, ['init', '-b', 'main']);
    await git(slowRepo, ['config', 'user.email', 'crew@nuncio.local']);
    await git(slowRepo, ['config', 'user.name', 'Crew Test']);
    await git(slowRepo, ['add', '.']);
    await git(slowRepo, ['commit', '-m', 'test: initialize slow fixture']);
    process.env.NUNCIO_DATA_DIR = join(root, 'data');
    process.env.NUNCIO_WORKSPACES_DIR = workspaces;
    process.env.NUNCIO_PROJECT_ROOTS = repo;
    process.env.NUNCIO_FORCE_MOCK = '1';
    app = await createApp();
  });
  afterAll(async () => {
    await app.close();
    rmSync(root, { recursive: true, force: true });
    for (const key of [
      'NUNCIO_DATA_DIR', 'NUNCIO_WORKSPACES_DIR', 'NUNCIO_PROJECT_ROOTS', 'NUNCIO_FORCE_MOCK',
    ]) delete process.env[key];
  });

  it('creates one real worktree and automatically reaches terminal success through every fixed stage', async () => {
    const profile = await request(app.getHttpServer()).post('/api/crew/profiles').send({
      name: 'Mock Quality', presetId: 'quality',
      definition: {
        bindings: {
          foreman: { provider: 'mock', model: 'mock:foreman' },
          builder: { provider: 'mock', model: 'mock:builder' },
          reviewer: { provider: 'mock', model: 'mock:reviewer' },
        },
        policy: {
          maxVerifyRetries: 2, maxReviewRetries: 2,
          strictFreshFinalReviewer: true, verifyCommand: null,
        },
      },
    });
    expect(profile.status).toBe(201);
    const created = await request(app.getHttpServer()).post('/api/crew/tasks').send({
      objective: 'Exercise the automatic Crew loop', projectPath: repo,
      baseBranch: 'main', profileId: profile.body.profile.id,
    });
    expect(created.status).toBe(201);
    const runId = created.body.run.id as string;
    const detail = await waitForTerminal(app, runId);
    expect(detail.run).toMatchObject({ phase: 'DONE', status: 'TERMINAL', outcome: 'SUCCEEDED' });
    expect(detail.run.worktreePath).toBe(realpathSync.native(join(workspaces, runId)));
    expect(detail.gates.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'verify', status: 'passed', workspaceHead: detail.run.workspaceHead }),
      expect.objectContaining({ kind: 'review', status: 'passed', workspaceHead: detail.run.workspaceHead }),
    ]));
    const events = await request(app.getHttpServer()).get(`/api/crew-runs/${runId}/events`);
    expect(events.body.events.map((event: { type: string }) => event.type)).toEqual(expect.arrayContaining([
      'plan_accepted', 'builder_completed', 'verify_passed', 'review_passed', 'synthesis_completed',
    ]));
    expect(detail.artifacts.every((artifact: Record<string, unknown>) => !('relativeStoragePath' in artifact))).toBe(true);
    expect(JSON.stringify(detail.artifacts)).not.toContain('"cwd"');
    expect(JSON.stringify(detail.artifacts)).not.toContain('"command"');
    const diffArtifact = detail.artifacts.find((artifact: { kind: string }) => artifact.kind === 'workspace-diff');
    expect(diffArtifact.metadata).toMatchObject({ uiTouched: false, uiFileCount: 0 });
    expect(JSON.stringify(diffArtifact)).not.toContain('uiFiles');
    const verifyArtifact = detail.artifacts.find((artifact: { kind: string }) => artifact.kind === 'verify-log');
    const range = await request(app.getHttpServer())
      .get(`/api/crew-runs/${runId}/artifacts/${verifyArtifact.id}?offset=0&limit=32`);
    expect(range.status).toBe(200);
    expect(range.body.range).toMatchObject({ artifactId: verifyArtifact.id, offset: 0 });
    expect(JSON.stringify(range.body)).not.toContain('relativeStoragePath');
    expect((await request(app.getHttpServer())
      .get(`/api/crew-runs/${runId}/artifacts/${verifyArtifact.id}?offset=-1`)).status).toBe(400);
  }, 30_000);

  it('boot recovery adopts a crash-created deterministic worktree and drives the queued run once', async () => {
    const tasks = app.get(CrewTasksRepository);
    const runs = app.get(CrewRunsRepository);
    const task = tasks.create({ objective: 'Recover queued work', projectPath: repo, baseBranch: 'main' });
    const baseHead = (await app.get(GitService).inspectBoundary(repo)).fullHead!;
    const run = runs.create({
      taskId: task.id, profileSnapshot: mockSnapshot(), projectPath: repo, baseBranch: 'main',
      baseHead, context: { objective: task.objective },
    });
    const sideEffect = await app.get(GitService).createWorktree(
      repo, 'main', run.id, task.objective,
    );
    expect(runs.findById(run.id)?.worktreePath).toBeNull();
    await app.close();
    app = await createApp();

    const detail = await waitForTerminal(app, run.id);
    expect(detail.run).toMatchObject({ outcome: 'SUCCEEDED', branch: sideEffect.branch });
    expect(detail.run.worktreePath).toBe(realpathSync.native(sideEffect.worktreePath));
    expect(detail.results.filter((item: { result: { kind: string } }) => item.result.kind === 'builder'))
      .toHaveLength(1);
  }, 30_000);

  it('keeps the global Crew task gate closed until a changed boot workspace is blocked and its queued task cancelled', async () => {
    const crewTask = app.get(CrewTasksRepository).create({
      objective: 'Never run changed workspace', projectPath: repo, baseBranch: 'main',
    });
    const runs = app.get(CrewRunsRepository);
    let run = runs.create({
      taskId: crewTask.id, profileSnapshot: mockSnapshot(), projectPath: repo, baseBranch: 'main',
      context: { objective: crewTask.objective },
    });
    const workspace = await app.get(GitService).createWorktree(repo, 'main', run.id, crewTask.objective);
    const initial = await app.get(GitService).inspectBoundary(workspace.worktreePath, workspace.branch);
    run = runs.applyEvent(run.id, {
      expectedRevision: run.revision, idempotencyKey: 'ordering:workspace', actor: 'test',
      event: { type: 'workspace_prepared', workspaceHead: initial.fullHead! },
      workspace: {
        worktreePath: initial.canonicalPath, branch: workspace.branch,
        baseBranch: workspace.baseBranch, baseHead: initial.fullHead,
      },
    });
    run = runs.applyEvent(run.id, {
      expectedRevision: run.revision, idempotencyKey: 'ordering:plan', actor: 'test', event: { type: 'plan_started' },
    });
    const queued = app.get(TasksRepository).create({
      prompt: 'This must not execute', provider: 'mock', model: 'mock:foreman',
      workspace: initial.canonicalPath, executionKind: 'crew-member', crewRunId: run.id,
      crewMemberKey: 'foreman:primary', crewPhase: 'PLAN', verifyOwner: 'crew',
      runtimePolicy: { filesystem: 'read-only', workspaceRoot: initial.canonicalPath, network: 'disabled' },
    });
    writeFileSync(join(initial.canonicalPath, 'external.txt'), 'changed after durable head\n');
    await git(initial.canonicalPath, ['add', '.']);
    await git(initial.canonicalPath, ['commit', '-m', 'test: diverge before restart']);
    await app.close();
    app = await createApp();
    await Bun.sleep(300);

    expect(app.get(CrewRunsRepository).findById(run.id)).toMatchObject({
      status: 'BLOCKED_USER', blockedReason: 'unrecoverable_failure', workspaceHead: initial.fullHead,
    });
    expect(app.get(TasksRepository).findById(queued.id)).toMatchObject({ status: 'CANCELLED', sessionId: null });
    const events = await request(app.getHttpServer()).get(`/api/crew-runs/${run.id}/events`);
    expect(events.body.events.some((event: { type: string }) => event.type === 'plan_accepted')).toBe(false);
  }, 30_000);

  it('aborts deterministic VERIFY on pause, emits no stale pass, then reruns cleanly on resume', async () => {
    const sentinel = '.crew-verify-sentinel-pause';
    const profileId = await createSlowProfile(
      app, `(sleep 2; printf survived > '${sentinel}') & wait; printf resumed-marker; exit 0`,
    );
    const created = await request(app.getHttpServer()).post('/api/crew/tasks').send({
      objective: 'Pause a long verification', projectPath: slowRepo, baseBranch: 'main', profileId,
    });
    const run = await waitForPhase(app, created.body.run.id, 'VERIFY', 'RUNNING');
    const paused = await request(app.getHttpServer()).post(`/api/crew-runs/${run.id}/pause`).send({
      expectedRevision: run.revision,
    });
    expect(paused.status).toBe(201);
    expect(paused.body.run.status).toBe('PAUSED');
    await Bun.sleep(2200);
    expect(existsSync(join(run.worktreePath, sentinel))).toBe(false);
    const beforeResume = await request(app.getHttpServer()).get(`/api/crew-runs/${run.id}/events`);
    expect(beforeResume.body.events.some((event: { type: string }) => event.type === 'verify_passed')).toBe(false);
    const resumed = await request(app.getHttpServer()).post(`/api/crew-runs/${run.id}/resume`).send({
      expectedRevision: paused.body.run.revision,
    });
    expect(resumed.status).toBe(201);
    const terminal = await waitForTerminal(app, run.id);
    expect(terminal.run.outcome).toBe('SUCCEEDED');
    expect(existsSync(join(run.worktreePath, sentinel))).toBe(false);
    const verifyArtifact = terminal.artifacts.filter(
      (artifact: { kind: string }) => artifact.kind === 'verify-log',
    ).at(-1);
    const evidence = await request(app.getHttpServer())
      .get(`/api/crew-runs/${run.id}/artifacts/${verifyArtifact.id}?offset=0&limit=256`);
    expect(evidence.body.range.text).toContain('resumed-marker');
  }, 30_000);

  it('aborts deterministic VERIFY on cancel and never applies late gate evidence', async () => {
    const sentinel = '.crew-verify-sentinel-cancel';
    const profileId = await createSlowProfile(app, `(sleep 2; printf survived > '${sentinel}') & wait; exit 0`);
    const created = await request(app.getHttpServer()).post('/api/crew/tasks').send({
      objective: 'Cancel a long verification', projectPath: slowRepo, baseBranch: 'main', profileId,
    });
    const run = await waitForPhase(app, created.body.run.id, 'VERIFY', 'RUNNING');
    const cancelled = await request(app.getHttpServer()).post(`/api/crew-runs/${run.id}/cancel`).send({
      expectedRevision: run.revision,
    });
    expect(cancelled.status).toBe(201);
    expect(cancelled.body.run).toMatchObject({ status: 'TERMINAL', outcome: 'CANCELLED' });
    await Bun.sleep(2200);
    expect(Bun.file(join(run.worktreePath, sentinel)).size).toBe(0);
    const events = await request(app.getHttpServer()).get(`/api/crew-runs/${run.id}/events`);
    expect(events.body.events.some((event: { type: string }) => event.type === 'verify_passed')).toBe(false);
  }, 30_000);

  it('quiesces an active Builder on pause and resumes it through a new owned attempt', async () => {
    const profileId = await createSlowProfile(app, 'true');
    const created = await request(app.getHttpServer()).post('/api/crew/tasks').send({
      objective: 'Pause active Builder safely', projectPath: slowRepo, baseBranch: 'main', profileId,
    });
    const run = await waitForPhase(app, created.body.run.id, 'BUILD', 'RUNNING');
    const paused = await request(app.getHttpServer()).post(`/api/crew-runs/${run.id}/pause`).send({
      expectedRevision: run.revision,
    });
    expect(paused.status).toBe(201);
    expect(paused.body.run).toMatchObject({ phase: 'BUILD', status: 'PAUSED' });
    expect(app.get(CrewWriterLeaseService).get(run.id)).toBeNull();
    const resumed = await request(app.getHttpServer()).post(`/api/crew-runs/${run.id}/resume`).send({
      expectedRevision: paused.body.run.revision,
    });
    expect(resumed.status).toBe(201);
    expect((await waitForTerminal(app, run.id)).run.outcome).toBe('SUCCEEDED');
  }, 30_000);

  it('quiesces and cancels the active Builder task and releases its writer lease before returning', async () => {
    const profileId = await createSlowProfile(app, 'true');
    const created = await request(app.getHttpServer()).post('/api/crew/tasks').send({
      objective: 'Cancel active Builder safely', projectPath: slowRepo, baseBranch: 'main', profileId,
    });
    const run = await waitForPhase(app, created.body.run.id, 'BUILD', 'RUNNING');
    const cancelled = await request(app.getHttpServer()).post(`/api/crew-runs/${run.id}/cancel`).send({
      expectedRevision: run.revision,
    });
    expect(cancelled.status).toBe(201);
    expect(cancelled.body.run).toMatchObject({ status: 'TERMINAL', outcome: 'CANCELLED' });
    expect(app.get(CrewWriterLeaseService).get(run.id)).toBeNull();
    expect(app.get(TasksService).listInternal().filter((task) => task.crewRunId === run.id)
      .every((task) => task.status !== 'RUNNING' && task.status !== 'QUEUED')).toBe(true);
    await Bun.sleep(800);
    const events = await request(app.getHttpServer()).get(`/api/crew-runs/${run.id}/events`);
    expect(events.body.events.some((event: { type: string }) => event.type === 'builder_completed')).toBe(false);
  }, 30_000);

  it('rechecks the frozen provider binding on Resume and recovers only when it is live', async () => {
    const available = await createProviderBlockedRun(app, mockSnapshot(), 'Recover provider');
    const resumed = await request(app.getHttpServer()).post(`/api/crew-runs/${available.id}/resume`).send({
      expectedRevision: available.revision,
    });
    expect(resumed.status).toBe(201);
    expect((await waitForTerminal(app, available.id)).run.outcome).toBe('SUCCEEDED');

    const unavailableSnapshot = mockSnapshot();
    unavailableSnapshot.bindings.foreman.model = 'mock:missing';
    const unavailable = await createProviderBlockedRun(app, unavailableSnapshot, 'Remain provider blocked');
    const unchanged = await request(app.getHttpServer()).post(`/api/crew-runs/${unavailable.id}/resume`).send({
      expectedRevision: unavailable.revision,
    });
    expect(unchanged.status).toBe(201);
    expect(unchanged.body.run).toMatchObject({
      revision: unavailable.revision, status: 'BLOCKED_PROVIDER', blockedReason: 'provider_unavailable',
    });
  }, 30_000);

  it('creates an immutable exact-head successor on the retained worktree and completes it', async () => {
    const profileId = await createSlowProfile(app, 'true');
    const created = await request(app.getHttpServer()).post('/api/crew/tasks').send({
      objective: 'Build then revise', projectPath: slowRepo, baseBranch: 'main', profileId,
    });
    const prior = (await waitForTerminal(app, created.body.run.id)).run;
    const priorBefore = (await request(app.getHttpServer()).get(`/api/crew-runs/${prior.id}`)).body.run;
    const successorResponse = await request(app.getHttpServer())
      .post(`/api/crew/tasks/${created.body.task.id}/runs`).send({
        priorRunId: prior.id, expectedRevision: prior.revision,
        expectedBaseHead: prior.workspaceHead, changeRequest: 'Add audit logging', profileId,
      });
    expect(successorResponse.status).toBe(201);
    expect(successorResponse.body.run).toMatchObject({
      priorRunId: prior.id, worktreePath: prior.worktreePath, branch: prior.branch,
      context: { changeRequest: 'Add audit logging', priorWorkspaceHead: prior.workspaceHead },
    });
    const successor = await waitForTerminal(app, successorResponse.body.run.id);
    expect(successor.run).toMatchObject({ outcome: 'SUCCEEDED', worktreePath: prior.worktreePath });
    expect((await request(app.getHttpServer()).get(`/api/crew-runs/${prior.id}`)).body.run).toEqual(priorBefore);
  }, 30_000);

  it('aborts active deterministic verification during graceful app shutdown without orphaning children', async () => {
    const sentinel = '.crew-verify-sentinel-shutdown';
    const profileId = await createSlowProfile(app, `(sleep 2; printf survived > '${sentinel}') & wait; exit 0`);
    const created = await request(app.getHttpServer()).post('/api/crew/tasks').send({
      objective: 'Shutdown a long verification', projectPath: slowRepo, baseBranch: 'main', profileId,
    });
    const run = await waitForPhase(app, created.body.run.id, 'VERIFY', 'RUNNING');
    await app.close();
    await Bun.sleep(2200);
    expect(Bun.file(join(run.worktreePath, sentinel)).size).toBe(0);
    app = await createApp();
  }, 30_000);
});

async function waitForTerminal(app: INestApplication, runId: string) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const response = await request(app.getHttpServer()).get(`/api/crew-runs/${runId}`);
    if (response.body.run?.status === 'TERMINAL') return response.body;
    if (response.body.run?.status?.startsWith('BLOCKED')) {
      throw new Error(`Crew blocked: ${JSON.stringify(response.body.run)} ${JSON.stringify(response.body)}`);
    }
    await Bun.sleep(50);
  }
  throw new Error(`CrewRun ${runId} did not finish`);
}

async function waitForPhase(app: INestApplication, runId: string, phase: string, status: string) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const response = await request(app.getHttpServer()).get(`/api/crew-runs/${runId}`);
    if (response.body.run?.phase === phase && response.body.run?.status === status) return response.body.run;
    if (response.body.run?.status?.startsWith('BLOCKED')) throw new Error(JSON.stringify(response.body.run));
    await Bun.sleep(20);
  }
  throw new Error(`CrewRun ${runId} did not reach ${phase}/${status}`);
}

async function git(cwd: string, args: string[]): Promise<void> {
  const process = Bun.spawn(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  const code = await process.exited;
  if (code !== 0) throw new Error(await new Response(process.stderr).text());
}

async function createApp(): Promise<INestApplication> {
  const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const application = module.createNestApplication({ rawBody: true });
  application.setGlobalPrefix('api');
  await application.init();
  return application;
}

function mockSnapshot(): CrewProfileSnapshot {
  return {
    presetId: 'quality', sourceProfileId: null, sourceProfileRevision: null, resolvedAt: Date.now(),
    bindings: {
      foreman: { provider: 'mock', model: 'mock:foreman', runtimePolicy: 'read-only' },
      builder: { provider: 'mock', model: 'mock:builder', runtimePolicy: 'workspace-write' },
      reviewer: { provider: 'mock', model: 'mock:reviewer', runtimePolicy: 'read-only' },
    },
    tester: { kind: 'nuncio', runtimePolicy: 'read-only' },
    policy: {
      maxVerifyRetries: 2, maxReviewRetries: 2,
      strictFreshFinalReviewer: true, verifyCommand: './.nuncio/verify',
    },
  };
}

async function createSlowProfile(app: INestApplication, verifyCommand: string): Promise<string> {
  const response = await request(app.getHttpServer()).post('/api/crew/profiles').send({
    name: `Slow Mock ${Date.now()}`, presetId: 'quality',
    definition: {
      bindings: {
        foreman: { provider: 'mock', model: 'mock:foreman' },
        builder: { provider: 'mock', model: 'mock:builder' },
        reviewer: { provider: 'mock', model: 'mock:reviewer' },
      },
      policy: {
        maxVerifyRetries: 2, maxReviewRetries: 2,
        strictFreshFinalReviewer: true, verifyCommand,
      },
    },
  });
  expect(response.status).toBe(201);
  return response.body.profile.id;
}

async function createProviderBlockedRun(
  app: INestApplication, snapshot: CrewProfileSnapshot, objective: string,
) {
  const task = app.get(CrewTasksRepository).create({ objective, projectPath: repoFor(app), baseBranch: 'main' });
  const runs = app.get(CrewRunsRepository);
  let run = runs.create({
    taskId: task.id, profileSnapshot: snapshot, projectPath: task.projectPath,
    baseBranch: 'main', context: { objective },
  });
  const workspace = await app.get(GitService).createWorktree(task.projectPath, 'main', run.id, objective);
  const boundary = await app.get(GitService).inspectBoundary(workspace.worktreePath, workspace.branch);
  run = runs.applyEvent(run.id, {
    expectedRevision: run.revision, idempotencyKey: 'e2e:workspace', actor: 'test',
    event: { type: 'workspace_prepared', workspaceHead: boundary.fullHead! },
    workspace: {
      worktreePath: boundary.canonicalPath, branch: workspace.branch,
      baseBranch: workspace.baseBranch, baseHead: boundary.fullHead,
    },
  });
  run = runs.applyEvent(run.id, {
    expectedRevision: run.revision, idempotencyKey: 'e2e:plan-start', actor: 'test', event: { type: 'plan_started' },
  });
  return runs.applyEvent(run.id, {
    expectedRevision: run.revision, idempotencyKey: 'e2e:provider-block', actor: 'test',
    event: { type: 'provider_unavailable', reason: 'simulated outage' },
  });
}

function repoFor(_app: INestApplication): string {
  return process.env.NUNCIO_PROJECT_ROOTS!;
}
