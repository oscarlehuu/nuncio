import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CrewBuildFinalizerService } from '../../../src/crew/crew-build-finalizer.service';
import { CrewWriterLeaseService } from '../../../src/crew/crew-writer-lease.service';
import { DatabaseService } from '../../../src/db/database.service';
import type { CrewProfileSnapshot } from '../../../src/crew/domain/crew.types';
import { ensureCrewSchema } from '../../../src/crew/persistence/crew-schema';
import { CrewEventsRepository } from '../../../src/crew/persistence/crew-events.repository';
import { CrewMembersRepository } from '../../../src/crew/persistence/crew-members.repository';
import { CrewResultsRepository } from '../../../src/crew/persistence/crew-results.repository';
import { CrewRunsRepository } from '../../../src/crew/persistence/crew-runs.repository';
import { CrewTasksRepository } from '../../../src/crew/persistence/crew-tasks.repository';
import { CrewWriterLeasesRepository } from '../../../src/crew/persistence/crew-writer-leases.repository';

const headA = 'a'.repeat(40);
const headB = 'b'.repeat(40);
const snapshot: CrewProfileSnapshot = {
  presetId: 'quality', sourceProfileId: 'p', sourceProfileRevision: 1, resolvedAt: 1,
  bindings: {
    foreman: { provider: 'mock', model: 'foreman', runtimePolicy: 'read-only' },
    builder: { provider: 'mock', model: 'builder', runtimePolicy: 'workspace-write' },
    reviewer: { provider: 'mock', model: 'reviewer', runtimePolicy: 'read-only' },
  }, tester: { kind: 'nuncio', runtimePolicy: 'read-only' },
  policy: { maxVerifyRetries: 2, maxReviewRetries: 2, strictFreshFinalReviewer: true, verifyCommand: 'true' },
};

describe('CrewBuildFinalizerService', () => {
  let dir: string;
  let database: DatabaseService;
  let runs: CrewRunsRepository;
  let members: CrewMembersRepository;
  let results: CrewResultsRepository;
  let leases: CrewWriterLeaseService;
  let runId: string;
  let memberId: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'crew-build-finalizer-'));
    process.env.NUNCIO_DATA_DIR = dir;
    database = new DatabaseService();
    ensureCrewSchema(database);
    runs = new CrewRunsRepository(database, new CrewEventsRepository(database));
    members = new CrewMembersRepository(database);
    results = new CrewResultsRepository(database);
    leases = new CrewWriterLeaseService(new CrewWriterLeasesRepository(database));
    const task = new CrewTasksRepository(database).create({ objective: 'Ship', projectPath: '/source' });
    let run = runs.create({ taskId: task.id, profileSnapshot: snapshot, projectPath: '/source' });
    run = runs.applyEvent(run.id, {
      expectedRevision: run.revision, idempotencyKey: 'workspace', actor: 'nuncio',
      event: { type: 'workspace_prepared', workspaceHead: headA },
      workspace: { worktreePath: '/worktree', branch: 'nuncio/run-ship', baseBranch: 'main' },
    });
    run = runs.applyEvent(run.id, {
      expectedRevision: run.revision, idempotencyKey: 'plan-start', actor: 'nuncio', event: { type: 'plan_started' },
    });
    run = runs.applyEvent(run.id, {
      expectedRevision: run.revision, idempotencyKey: 'plan-pass', actor: 'nuncio', event: { type: 'plan_accepted' },
    });
    run = runs.applyEvent(run.id, {
      expectedRevision: run.revision, idempotencyKey: 'builder-start', actor: 'nuncio', event: { type: 'builder_claimed' },
    });
    runId = run.id;
    const member = members.replaceCurrent({
      runId, memberKey: 'builder:primary', provider: 'mock', model: 'builder', sessionId: 'session-b',
      priorMemberSessionId: null, lifecycle: 'active', contextHealth: 'healthy',
      lastSeenContextRevision: run.contextRevision, lastSeenWorkspaceHead: headA, lastUsedAt: 1,
    });
    memberId = member.id;
    results.createIdempotent({
      runId, memberSessionId: member.id, phase: 'BUILD', attempt: 1,
      result: {
        kind: 'builder-intent', summary: 'Built', changedFiles: ['src/a.ts'], basedOnWorkspaceHead: headA,
      }, basedOnContextRevision: run.contextRevision, workspaceHead: headA,
    }, 'build-intent');
    leases.acquire({ runId, memberSessionId: member.id, memberKey: member.memberKey, startingHead: headA });
  });
  afterEach(() => {
    database.onModuleDestroy();
    rmSync(dir, { recursive: true, force: true });
    delete process.env.NUNCIO_DATA_DIR;
  });

  it('checkpoints only after task settlement and persists actual head B evidence', async () => {
    let currentHead = headA;
    const checkpoint = jest.fn(async () => {
      currentHead = headB;
      return { fullHead: headB, clean: true, committed: true };
    });
    const validateCheckpointRange = jest.fn(async () => {});
    const service = new CrewBuildFinalizerService(
      runs, members, results, leases,
      {
        inspectBoundary: async () => boundary(currentHead, true), checkpoint,
        validateCheckpointRange,
      } as never,
    );
    const notice = await service.finalizeSettled(runId, memberId);
    expect(checkpoint).toHaveBeenCalledTimes(1);
    expect(validateCheckpointRange).toHaveBeenCalledWith('/worktree', headA, headB);
    expect(notice.result.result).toMatchObject({
      kind: 'builder', basedOnWorkspaceHead: headA, commitHead: headB,
    });
    expect(leases.get(runId)).toBeNull();
  });

  it('reconciles a crash after checkpoint from clean descendant B without committing again', async () => {
    const checkpoint = jest.fn();
    const service = new CrewBuildFinalizerService(
      runs, members, results, leases,
      {
        inspectBoundary: async () => boundary(headB, true), checkpoint,
        validateCheckpointRange: jest.fn(async () => {}),
      } as never,
    );
    expect((await service.finalizeSettled(runId, memberId)).workspaceHead).toBe(headB);
    expect(checkpoint).not.toHaveBeenCalled();
  });

  it('rejects a self-committed secret in the exact lease-to-final-head range before accepting Builder evidence', async () => {
    const validateCheckpointRange = jest.fn(async () => {
      throw new Error('checkpoint contains a blocked secret');
    });
    const service = new CrewBuildFinalizerService(
      runs, members, results, leases,
      {
        inspectBoundary: async () => boundary(headB, true), checkpoint: jest.fn(),
        validateCheckpointRange,
      } as never,
    );
    await expect(service.finalizeSettled(runId, memberId)).rejects.toThrow('blocked secret');
    expect(validateCheckpointRange).toHaveBeenCalledWith('/worktree', headA, headB);
    expect(results.listByRun(runId).filter((item) => item.result.kind === 'builder')).toHaveLength(0);
    expect(leases.get(runId)).not.toBeNull();
  });

  it('blocks a dirty descendant instead of guessing or overwriting after a checkpoint crash', async () => {
    const service = new CrewBuildFinalizerService(
      runs, members, results, leases,
      { inspectBoundary: async () => ({ ...boundary(headB, true), clean: false }), checkpoint: jest.fn() } as never,
    );
    await expect(service.finalizeSettled(runId, memberId)).rejects.toThrow('dirty descendant');
    expect(results.listByRun(runId).filter((item) => item.result.kind === 'builder')).toHaveLength(0);
    expect(leases.get(runId)).not.toBeNull();
  });
});

function boundary(fullHead: string, reachable: boolean) {
  return {
    ok: true, exists: true, symlink: false, canonicalPath: '/worktree',
    branch: 'nuncio/run-ship', fullHead, clean: true, reachable, reason: null,
  };
}
