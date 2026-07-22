import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CrewContextService } from '../../../src/crew/crew-context.service';
import { CrewBuildFinalizerService } from '../../../src/crew/crew-build-finalizer.service';
import { CrewBuildRecoveryFinalizerService } from '../../../src/crew/crew-build-recovery-finalizer.service';
import { CrewMemberService } from '../../../src/crew/crew-member.service';
import { CrewRecoveryService } from '../../../src/crew/crew-recovery.service';
import { CrewRunnerExecutionService } from '../../../src/crew/crew-runner-execution.service';
import { CrewWriterLeaseService } from '../../../src/crew/crew-writer-lease.service';
import { crewToolAuthority } from '../../../src/crew/crew-tool-authority';
import { DatabaseService } from '../../../src/db/database.service';
import type { CrewProfileSnapshot } from '../../../src/crew/domain/crew.types';
import { ensureCrewSchema } from '../../../src/crew/persistence/crew-schema';
import { CrewArtifactsRepository } from '../../../src/crew/persistence/crew-artifacts.repository';
import { CrewEventsRepository } from '../../../src/crew/persistence/crew-events.repository';
import { CrewMembersRepository } from '../../../src/crew/persistence/crew-members.repository';
import { CrewResultsRepository } from '../../../src/crew/persistence/crew-results.repository';
import { CrewRunsRepository } from '../../../src/crew/persistence/crew-runs.repository';
import { CrewTasksRepository } from '../../../src/crew/persistence/crew-tasks.repository';
import { CrewWriterLeasesRepository } from '../../../src/crew/persistence/crew-writer-leases.repository';

const head = 'a'.repeat(40);
const checkpointHead = 'b'.repeat(40);
const snapshot: CrewProfileSnapshot = {
  presetId: 'quality', sourceProfileId: 'p', sourceProfileRevision: 1, resolvedAt: 1,
  bindings: {
    foreman: { provider: 'claude', model: 'foreman', runtimePolicy: 'read-only' },
    builder: { provider: 'codex', model: 'builder', runtimePolicy: 'workspace-write' },
    reviewer: { provider: 'claude', model: 'reviewer', runtimePolicy: 'read-only' },
  }, tester: { kind: 'nuncio', runtimePolicy: 'read-only' },
  policy: { maxVerifyRetries: 2, maxReviewRetries: 2, strictFreshFinalReviewer: true, verifyCommand: 'true' },
};

describe('CrewRecoveryService', () => {
  let dir: string; let db: DatabaseService; let runs: CrewRunsRepository;
  let members: CrewMembersRepository; let results: CrewResultsRepository;
  let leases: CrewWriterLeaseService; let runId: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'crew-recovery-')); process.env.NUNCIO_DATA_DIR = dir;
    db = new DatabaseService(); ensureCrewSchema(db);
    runs = new CrewRunsRepository(db, new CrewEventsRepository(db));
    members = new CrewMembersRepository(db); results = new CrewResultsRepository(db);
    leases = new CrewWriterLeaseService(new CrewWriterLeasesRepository(db));
    const task = new CrewTasksRepository(db).create({ objective: 'Ship', projectPath: '/repo' });
    let run = runs.create({ taskId: task.id, profileSnapshot: snapshot, projectPath: '/repo' });
    run = runs.applyEvent(run.id, {
      expectedRevision: run.revision, idempotencyKey: 'workspace', actor: 'test',
      event: { type: 'workspace_prepared', workspaceHead: head },
      workspace: { worktreePath: '/worktree', branch: 'nuncio/run', baseBranch: 'main', baseHead: head },
    });
    run = runs.applyEvent(run.id, {
      expectedRevision: run.revision, idempotencyKey: 'plan-start', actor: 'test', event: { type: 'plan_started' },
    });
    run = runs.applyEvent(run.id, {
      expectedRevision: run.revision, idempotencyKey: 'plan-done', actor: 'test', event: { type: 'plan_accepted' },
    });
    runId = run.id;
  });
  afterEach(() => {
    db.onModuleDestroy(); rmSync(dir, { recursive: true, force: true }); delete process.env.NUNCIO_DATA_DIR;
  });

  it('preserves dirty mid-BUILD edits, reacquires one lease, and resumes the same healthy Builder session', async () => {
    let run = runs.findById(runId)!;
    run = runs.applyEvent(runId, {
      expectedRevision: run.revision, idempotencyKey: 'build-start', actor: 'test', event: { type: 'builder_claimed' },
    });
    const builder = members.replaceCurrent({
      runId, memberKey: 'builder:primary', provider: 'codex', model: 'builder', sessionId: 'builder-session',
      priorMemberSessionId: null, lifecycle: 'active', contextHealth: 'healthy',
      lastSeenContextRevision: run.contextRevision, lastSeenWorkspaceHead: head, lastUsedAt: 1,
    });
    results.createIdempotent({
      runId, memberSessionId: builder.id, phase: 'BUILD', attempt: 1,
      result: { kind: 'builder-intent', summary: 'Unsettled', changedFiles: ['dirty.ts'], basedOnWorkspaceHead: head },
      basedOnContextRevision: run.contextRevision, workspaceHead: head,
    }, crewToolAuthority(run, builder, 'build').idempotencyKey);
    leases.acquire({ runId, memberSessionId: builder.id, memberKey: builder.memberKey, startingHead: head });
    const attempts: Array<Record<string, unknown>> = [];
    const executionPort = {
      startAttempt: async (input: Record<string, unknown>) => {
        attempts.push(input); return { taskId: 'new-task', sessionId: 'builder-session', continued: true };
      },
      canResumeSession: async () => true,
    };
    const memberService = new CrewMemberService(
      runs, members, new CrewContextService(runs, new CrewArtifactsRepository(db)), executionPort as never,
    );
    const boundary = {
      ok: true, exists: true, symlink: false, canonicalPath: '/worktree', branch: 'nuncio/run',
      fullHead: head, clean: false, reachable: true, reason: null,
    };
    const runnerExecution = new CrewRunnerExecutionService(
      db, runs, members, memberService, leases, {} as never, {} as never,
      { inspectBoundary: async () => boundary } as never,
    );
    const runner = {
      drive: async (id: string) => runnerExecution.startBuilder(runs.findById(id)!),
      start: async () => runs.findById(runId)!, quiesceCrewRun: async () => {}, markExecutionReady: () => {},
    };
    const recovery = service(memberService, runner, boundary);
    const recovered = await recovery.recover(runId);
    expect(recovered).toMatchObject({ phase: 'BUILD', status: 'RUNNING', workspaceHead: head });
    expect(attempts[0]).toMatchObject({ existingSessionId: 'builder-session', workspace: '/worktree' });
    expect(members.findCurrent(runId, 'builder:primary')?.id).toBe(builder.id);
    expect(leases.get(runId)).toMatchObject({ memberSessionId: builder.id, startingHead: head });
    expect(results.listByRun(runId).filter((item) => item.result.kind === 'builder')).toHaveLength(0);
  });

  it('replaces a stale Builder session and sends a full envelope before resuming dirty BUILD work', async () => {
    let run = runs.findById(runId)!;
    run = runs.applyEvent(runId, {
      expectedRevision: run.revision, idempotencyKey: 'stale-build-start', actor: 'test',
      event: { type: 'builder_claimed' },
    });
    const staleBuilder = members.replaceCurrent({
      runId, memberKey: 'builder:primary', provider: 'codex', model: 'builder', sessionId: 'stale-session',
      priorMemberSessionId: null, lifecycle: 'active', contextHealth: 'healthy',
      lastSeenContextRevision: run.contextRevision, lastSeenWorkspaceHead: head, lastUsedAt: 1,
    });
    results.createIdempotent({
      runId, memberSessionId: staleBuilder.id, phase: 'BUILD', attempt: 1,
      result: { kind: 'builder-intent', summary: 'Unsettled', changedFiles: ['dirty.ts'], basedOnWorkspaceHead: head },
      basedOnContextRevision: run.contextRevision, workspaceHead: head,
    }, crewToolAuthority(run, staleBuilder, 'build').idempotencyKey);
    leases.acquire({
      runId, memberSessionId: staleBuilder.id, memberKey: staleBuilder.memberKey, startingHead: head,
    });
    const attempts: Array<Record<string, unknown>> = [];
    const executionPort = {
      startAttempt: async (input: Record<string, unknown>) => {
        attempts.push(input);
        return { taskId: 'replacement-task', sessionId: 'replacement-session', continued: false };
      },
      canResumeSession: async () => false,
    };
    const memberService = new CrewMemberService(
      runs, members, new CrewContextService(runs, new CrewArtifactsRepository(db)), executionPort as never,
    );
    const boundary = {
      ok: true, exists: true, symlink: false, canonicalPath: '/worktree', branch: 'nuncio/run',
      fullHead: head, clean: false, reachable: true, reason: null,
    };
    const runnerExecution = new CrewRunnerExecutionService(
      db, runs, members, memberService, leases, {} as never, {} as never,
      { inspectBoundary: async () => boundary } as never,
    );
    const runner = {
      drive: async (id: string) => runnerExecution.startBuilder(runs.findById(id)!),
      start: async () => runs.findById(runId)!, quiesceCrewRun: async () => {}, markExecutionReady: () => {},
    };

    const recovered = await service(memberService, runner, boundary).recover(runId);

    const replacement = members.findCurrent(runId, 'builder:primary')!;
    expect(recovered).toMatchObject({ phase: 'BUILD', status: 'RUNNING', workspaceHead: head });
    expect(replacement).toMatchObject({
      sessionId: 'replacement-session', priorMemberSessionId: staleBuilder.id, contextHealth: 'healthy',
    });
    expect(replacement.id).not.toBe(staleBuilder.id);
    expect(attempts[0]).toMatchObject({ existingSessionId: null, workspace: '/worktree' });
    expect(String(attempts[0]?.prompt)).toContain('"kind": "full"');
    expect(leases.get(runId)).toMatchObject({ memberSessionId: replacement.id, startingHead: head });
  });

  it('finalizes a durable Builder intent after checkpoint crash before comparing the stored head', async () => {
    createInterruptedBuild(false);
    const checkpoint = jest.fn();
    const validateCheckpointRange = jest.fn(async () => {});
    const boundary = {
      ok: true, exists: true, symlink: false, canonicalPath: '/worktree', branch: 'nuncio/run',
      fullHead: checkpointHead, clean: true, reachable: true, reason: null,
    };
    const recovery = service(
      { canResumeSession: async () => true, ensureMember: jest.fn() }, runnerStub(), boundary,
      undefined, acceptRecoveredBuild, { checkpoint, validateCheckpointRange },
    );

    const recovered = await recovery.recover(runId);
    expect(recovered).toMatchObject({ phase: 'VERIFY', status: 'QUEUED', workspaceHead: checkpointHead });
    expect(checkpoint).not.toHaveBeenCalled();
    expect(validateCheckpointRange).toHaveBeenCalledWith('/worktree', head, checkpointHead);
    expect(results.listByRun(runId).filter((item) => item.result.kind === 'builder')).toHaveLength(1);
    expect(leases.get(runId)).toBeNull();
  });

  it('replays a persisted Builder result and releases its lease after a pre-release crash', async () => {
    createInterruptedBuild(true);
    const boundary = {
      ok: true, exists: true, symlink: false, canonicalPath: '/worktree', branch: 'nuncio/run',
      fullHead: checkpointHead, clean: true, reachable: true, reason: null,
    };
    const recovery = service(
      { canResumeSession: async () => true, ensureMember: jest.fn() }, runnerStub(), boundary,
      undefined, acceptRecoveredBuild,
    );

    const recovered = await recovery.recover(runId);
    expect(recovered).toMatchObject({ phase: 'VERIFY', status: 'QUEUED', workspaceHead: checkpointHead });
    expect(results.listByRun(runId).filter((item) => item.result.kind === 'builder')).toHaveLength(1);
    expect(leases.get(runId)).toBeNull();
  });

  it('replays a persisted Builder result after its lease was already released', async () => {
    createInterruptedBuild(true);
    const lease = leases.get(runId)!;
    leases.release(runId, lease.token);
    const boundary = {
      ok: true, exists: true, symlink: false, canonicalPath: '/worktree', branch: 'nuncio/run',
      fullHead: checkpointHead, clean: true, reachable: true, reason: null,
    };
    const recovery = service(
      { canResumeSession: async () => true, ensureMember: jest.fn() }, runnerStub(), boundary,
      undefined, acceptRecoveredBuild,
    );

    const recovered = await recovery.recover(runId);

    expect(recovered).toMatchObject({ phase: 'VERIFY', status: 'QUEUED', workspaceHead: checkpointHead });
    expect(results.listByRun(runId).filter((item) => item.result.kind === 'builder')).toHaveLength(1);
    expect(leases.get(runId)).toBeNull();
  });

  it('retries finalized Builder projection after a transient write failure', async () => {
    createInterruptedBuild(true);
    const boundary = {
      ok: true, exists: true, symlink: false, canonicalPath: '/worktree', branch: 'nuncio/run',
      fullHead: checkpointHead, clean: true, reachable: true, reason: null,
    };
    let projectionAttempts = 0;
    const recovery = service(
      { canResumeSession: async () => true, ensureMember: jest.fn() }, runnerStub(), boundary,
      undefined,
      (notice) => {
        projectionAttempts += 1;
        if (projectionAttempts === 1) throw new Error('transient projection write failure');
        return acceptRecoveredBuild(notice);
      },
    );

    await recovery.recoverAll();
    expect(runs.findById(runId)).toMatchObject({
      phase: 'BUILD', status: 'BLOCKED_USER', blockedReason: 'unrecoverable_failure',
    });
    expect(results.listByRun(runId).filter((item) => item.result.kind === 'builder')).toHaveLength(1);
    expect(leases.get(runId)).toBeNull();

    const recovered = await recovery.recover(runId);

    expect(recovered).toMatchObject({ phase: 'VERIFY', status: 'QUEUED', workspaceHead: checkpointHead });
    expect(projectionAttempts).toBe(2);
    expect(results.listByRun(runId).filter((item) => item.result.kind === 'builder')).toHaveLength(1);
  });

  it('reruns interrupted VERIFY without probing or replacing an unavailable Foreman', async () => {
    let run = runs.findById(runId)!;
    run = runs.applyEvent(runId, {
      expectedRevision: run.revision, idempotencyKey: 'b-start', actor: 'test', event: { type: 'builder_claimed' },
    });
    run = runs.applyEvent(runId, {
      expectedRevision: run.revision, idempotencyKey: 'b-done', actor: 'test',
      event: { type: 'builder_completed', basedOnContextRevision: run.contextRevision, workspaceHead: head },
    });
    run = runs.applyEvent(runId, {
      expectedRevision: run.revision, idempotencyKey: 'v-start', actor: 'test',
      event: { type: 'verify_started', basedOnWorkspaceHead: head },
    });
    const foreman = members.replaceCurrent({
      runId, memberKey: 'foreman:primary', provider: 'claude', model: 'foreman', sessionId: 'foreman-session',
      priorMemberSessionId: null, lifecycle: 'active', contextHealth: 'healthy',
      lastSeenContextRevision: 1, lastSeenWorkspaceHead: head, lastUsedAt: 1,
    });
    const canResumeSession = jest.fn(async () => false);
    const ensureMember = jest.fn();
    const memberService = { canResumeSession, ensureMember };
    const boundary = {
      ok: true, exists: true, symlink: false, canonicalPath: '/worktree', branch: 'nuncio/run',
      fullHead: head, clean: true, reachable: true, reason: null,
    };
    const recovery = service(memberService, {
      drive: async () => runs.findById(runId)!, start: async () => runs.findById(runId)!,
      quiesceCrewRun: async () => {}, markExecutionReady: () => {},
    }, boundary, async () => { throw new Error('Foreman provider unavailable'); });
    const recovered = await recovery.recover(runId);
    expect(recovered).toMatchObject({ phase: 'VERIFY', status: 'QUEUED' });
    expect(canResumeSession).not.toHaveBeenCalled();
    expect(ensureMember).not.toHaveBeenCalled();
    expect(members.findCurrent(runId, 'foreman:primary')).toMatchObject({ id: foreman.id, sessionId: 'foreman-session' });
  });

  it('never replays a finalized Builder result from an earlier review-loop attempt', async () => {
    let run = runs.findById(runId)!;
    run = runs.applyEvent(runId, { expectedRevision: run.revision, idempotencyKey: 'a1-start', actor: 'test', event: { type: 'builder_claimed' } });
    const builder = members.replaceCurrent({
      runId, memberKey: 'builder:primary', provider: 'codex', model: 'builder', sessionId: 'builder-session',
      priorMemberSessionId: null, lifecycle: 'active', contextHealth: 'healthy',
      lastSeenContextRevision: run.contextRevision, lastSeenWorkspaceHead: head, lastUsedAt: 1,
    });
    const intent = results.createIdempotent({
      runId, memberSessionId: builder.id, phase: 'BUILD', attempt: 1,
      result: { kind: 'builder-intent', summary: 'Old', changedFiles: [], basedOnWorkspaceHead: head },
      basedOnContextRevision: run.contextRevision, workspaceHead: head,
    }, crewToolAuthority(run, builder, 'build').idempotencyKey).result;
    results.createIdempotent({
      runId, memberSessionId: builder.id, phase: 'BUILD', attempt: 2,
      result: { kind: 'builder', summary: 'Old', changedFiles: [], basedOnWorkspaceHead: head, commitHead: head },
      basedOnContextRevision: run.contextRevision, workspaceHead: head,
    }, `build-final:${intent.id}`);
    run = runs.applyEvent(runId, { expectedRevision: run.revision, idempotencyKey: 'a1-done', actor: 'test', event: { type: 'builder_completed', basedOnContextRevision: run.contextRevision, workspaceHead: head } });
    run = runs.applyEvent(runId, { expectedRevision: run.revision, idempotencyKey: 'v1', actor: 'test', event: { type: 'verify_started', basedOnWorkspaceHead: head } });
    run = runs.applyEvent(runId, { expectedRevision: run.revision, idempotencyKey: 'v2', actor: 'test', event: { type: 'verify_passed', basedOnWorkspaceHead: head } });
    run = runs.applyEvent(runId, { expectedRevision: run.revision, idempotencyKey: 'r1', actor: 'test', event: { type: 'reviewer_claimed', basedOnWorkspaceHead: head } });
    run = runs.applyEvent(runId, { expectedRevision: run.revision, idempotencyKey: 'r2', actor: 'test', event: { type: 'changes_requested', basedOnWorkspaceHead: head } });
    run = runs.applyEvent(runId, { expectedRevision: run.revision, idempotencyKey: 'a2-start', actor: 'test', event: { type: 'builder_claimed' } });
    const accept = jest.fn();
    const boundary = { ok: true, exists: true, symlink: false, canonicalPath: '/worktree', branch: 'nuncio/run', fullHead: head, clean: false, reachable: true, reason: null };
    const recovery = service(
      { canResumeSession: async () => true, ensureMember: jest.fn() },
      { drive: async () => runs.findById(runId)!, start: async () => runs.findById(runId)!, quiesceCrewRun: async () => {}, markExecutionReady: () => {} },
      boundary, undefined, accept,
    );
    expect(await recovery.recover(runId)).toMatchObject({ phase: 'BUILD', status: 'QUEUED', reviewRetriesUsed: 1 });
    expect(accept).not.toHaveBeenCalled();
  });

  it('redacts recovery failure reasons before event and Attention persistence', async () => {
    const token = `sk-ant-${'q'.repeat(32)}`;
    const attention = { raise: jest.fn(), clear: jest.fn() };
    const recovery = new CrewRecoveryService(
      db, runs, members, results, leases,
      { canResumeSession: async () => true, ensureMember: jest.fn() } as never,
      { accept: async () => runs.findById(runId)! } as never,
      { finalizeCrashGap: async () => null } as never,
      {
        drive: async () => runs.findById(runId)!, start: async () => runs.findById(runId)!,
        quiesceCrewRun: async () => {}, markExecutionReady: () => {},
      } as never,
      { list: async () => [] } as never,
      { inspectBoundary: async () => ({ ok: false, reason: `provider echoed ${token}` }) } as never,
      attention as never,
    );

    await recovery.recoverAll();

    const events = new CrewEventsRepository(db).listAll(runId);
    expect(JSON.stringify(events)).not.toContain(token);
    expect(JSON.stringify(events)).toContain('[REDACTED]');
    expect(JSON.stringify(attention.raise.mock.calls)).not.toContain(token);
    expect(JSON.stringify(attention.raise.mock.calls)).toContain('[REDACTED]');
  });

  it('keeps Crew task claims closed when asynchronous boot recovery rejects', async () => {
    let releaseRecovery!: () => void;
    const recoveryGate = new Promise<void>((resolve) => { releaseRecovery = resolve; });
    const markExecutionReady = jest.fn();
    const recovery = service(
      { canResumeSession: async () => true, ensureMember: jest.fn() },
      {
        drive: async () => runs.findById(runId)!, start: async () => runs.findById(runId)!,
        quiesceCrewRun: async () => {}, markExecutionReady,
      },
      { ok: true, exists: true, symlink: false, canonicalPath: '/worktree', branch: 'nuncio/run',
        fullHead: head, clean: true, reachable: true, reason: null },
    );
    recovery.recoverAll = async () => {
      await recoveryGate;
      throw new Error('recovery infrastructure failed');
    };

    const boot = recovery.onApplicationBootstrap();
    await Promise.resolve();
    expect(markExecutionReady).not.toHaveBeenCalled();
    releaseRecovery();

    await expect(boot).rejects.toThrow('recovery infrastructure failed');
    expect(markExecutionReady).not.toHaveBeenCalled();
  });

  function service(
    memberService: object, runner: object, boundary: object,
    catalog = async () => [{ provider: 'codex', models: ['builder'], runtimePolicies: ['workspace-write'] }],
    accept: (notice: unknown) => unknown = async () => runs.findById(runId)!,
    workspaceOverrides: Record<string, unknown> = {},
  ) {
    const workspace = { inspectBoundary: async () => boundary, ...workspaceOverrides };
    const finalizer = new CrewBuildFinalizerService(runs, members, results, leases, workspace as never);
    const buildRecovery = new CrewBuildRecoveryFinalizerService(results, finalizer, workspace as never);
    return new CrewRecoveryService(
      db, runs, members, results, leases, memberService as never,
      { accept } as never, buildRecovery, runner as never,
      { list: catalog } as never,
      workspace as never,
      { raise: jest.fn(), clear: jest.fn() } as never,
    );
  }

  function createInterruptedBuild(finalized: boolean): void {
    let run = runs.findById(runId)!;
    run = runs.applyEvent(runId, {
      expectedRevision: run.revision, idempotencyKey: 'crash-build-start', actor: 'test',
      event: { type: 'builder_claimed' },
    });
    const builder = members.replaceCurrent({
      runId, memberKey: 'builder:primary', provider: 'codex', model: 'builder', sessionId: 'builder-session',
      priorMemberSessionId: null, lifecycle: 'active', contextHealth: 'healthy',
      lastSeenContextRevision: run.contextRevision, lastSeenWorkspaceHead: head, lastUsedAt: 1,
    });
    const intent = results.createIdempotent({
      runId, memberSessionId: builder.id, phase: 'BUILD', attempt: 1,
      result: {
        kind: 'builder-intent', summary: 'Checkpointed', changedFiles: ['src/a.ts'], basedOnWorkspaceHead: head,
      },
      basedOnContextRevision: run.contextRevision, workspaceHead: head,
    }, crewToolAuthority(run, builder, 'build').idempotencyKey).result;
    if (finalized) results.createIdempotent({
      runId, memberSessionId: builder.id, phase: 'BUILD', attempt: 2,
      result: {
        kind: 'builder', summary: 'Checkpointed', changedFiles: ['src/a.ts'],
        basedOnWorkspaceHead: head, commitHead: checkpointHead,
      },
      basedOnContextRevision: run.contextRevision, workspaceHead: checkpointHead,
    }, `build-final:${intent.id}`);
    leases.acquire({ runId, memberSessionId: builder.id, memberKey: builder.memberKey, startingHead: head });
  }

  function acceptRecoveredBuild(notice: unknown) {
    const current = runs.findById(runId)!;
    const workspaceHead = (notice as { workspaceHead: string }).workspaceHead;
    return runs.applyEvent(runId, {
      expectedRevision: current.revision, idempotencyKey: `recovered-build:${current.revision}`, actor: 'test',
      event: { type: 'builder_completed', basedOnContextRevision: current.contextRevision, workspaceHead },
    });
  }

  function runnerStub() {
    return {
      drive: async () => runs.findById(runId)!, start: async () => runs.findById(runId)!,
      quiesceCrewRun: async () => {}, markExecutionReady: () => {},
    };
  }
});
