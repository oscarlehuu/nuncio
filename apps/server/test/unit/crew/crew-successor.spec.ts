import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CrewSuccessorService } from '../../../src/crew/crew-successor.service';
import { DatabaseService } from '../../../src/db/database.service';
import { CrewRevisionConflictError } from '../../../src/crew/domain/crew-errors';
import type { CrewProfileSnapshot } from '../../../src/crew/domain/crew.types';
import { ensureCrewSchema } from '../../../src/crew/persistence/crew-schema';
import { CrewEventsRepository } from '../../../src/crew/persistence/crew-events.repository';
import { CrewMembersRepository } from '../../../src/crew/persistence/crew-members.repository';
import { CrewRunsRepository } from '../../../src/crew/persistence/crew-runs.repository';
import { CrewTasksRepository } from '../../../src/crew/persistence/crew-tasks.repository';

const head = 'a'.repeat(40);
const snapshot: CrewProfileSnapshot = {
  presetId: 'quality', sourceProfileId: 'p', sourceProfileRevision: 1, resolvedAt: 1,
  bindings: {
    foreman: { provider: 'codex', model: 'f', runtimePolicy: 'read-only' },
    builder: { provider: 'codex', model: 'b', runtimePolicy: 'workspace-write' },
    reviewer: { provider: 'claude', model: 'r', runtimePolicy: 'read-only' },
  }, tester: { kind: 'nuncio', runtimePolicy: 'read-only' },
  policy: { maxVerifyRetries: 2, maxReviewRetries: 2, strictFreshFinalReviewer: true, verifyCommand: 'true' },
};

describe('CrewSuccessorService', () => {
  let dir: string; let db: DatabaseService; let runs: CrewRunsRepository;
  let members: CrewMembersRepository; let tasks: CrewTasksRepository;
  let prior: ReturnType<CrewRunsRepository['create']>; let task: ReturnType<CrewTasksRepository['create']>;
  let boundary: Record<string, unknown>;
  let service: CrewSuccessorService;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'crew-successor-')); process.env.NUNCIO_DATA_DIR = dir;
    db = new DatabaseService(); ensureCrewSchema(db);
    runs = new CrewRunsRepository(db, new CrewEventsRepository(db));
    members = new CrewMembersRepository(db); tasks = new CrewTasksRepository(db);
    task = tasks.create({ objective: 'Ship', projectPath: '/repo', baseBranch: 'main' });
    prior = runs.create({ taskId: task.id, profileSnapshot: snapshot, projectPath: '/repo', baseBranch: 'main' });
    prior = runs.applyEvent(prior.id, {
      expectedRevision: prior.revision, idempotencyKey: 'workspace', actor: 'test',
      event: { type: 'workspace_prepared', workspaceHead: head },
      workspace: { worktreePath: '/worktree', branch: 'nuncio/prior-ship', baseBranch: 'main' },
    });
    for (const [role, sessionId] of [['foreman', 'session-f'], ['builder', 'session-b'], ['reviewer', 'session-r']] as const) {
      const binding = snapshot.bindings[role];
      members.replaceCurrent({
        runId: prior.id, memberKey: `${role}:primary`, provider: binding.provider, model: binding.model,
        sessionId, priorMemberSessionId: null, lifecycle: 'active', contextHealth: 'healthy',
        lastSeenContextRevision: 2, lastSeenWorkspaceHead: head, lastUsedAt: 1,
      });
    }
    prior = runs.applyEvent(prior.id, {
      expectedRevision: prior.revision, idempotencyKey: 'terminal', actor: 'test', event: { type: 'cancel_requested' },
    });
    boundary = {
      ok: true, exists: true, symlink: false, clean: true, reachable: true,
      canonicalPath: '/worktree', branch: 'nuncio/prior-ship', fullHead: head, reason: null,
    };
    service = new CrewSuccessorService(
      db, runs, members,
      { canResumeSession: async () => true } as never,
      { items: () => [{ kind: 'verify', status: 'passed', workspaceHead: head }] } as never,
      { start: async (id: string) => runs.findById(id)! } as never,
      { inspectBoundary: async () => boundary } as never,
    );
  });
  afterEach(() => {
    db.onModuleDestroy(); rmSync(dir, { recursive: true, force: true }); delete process.env.NUNCIO_DATA_DIR;
  });

  it('adopts exact prior head/worktree and links reusable Foreman/Builder sessions without mutating prior', async () => {
    const before = structuredClone(runs.findById(prior.id));
    const successor = await service.create({
      task, prior, profileSnapshot: { ...snapshot, resolvedAt: 2 }, changeRequest: 'Add audit logging',
    });
    expect(successor).toMatchObject({
      priorRunId: prior.id, worktreePath: '/worktree', branch: 'nuncio/prior-ship', workspaceHead: head,
      context: { changeRequest: 'Add audit logging', priorWorkspaceHead: head },
    });
    const priorMembers = members.listByRun(prior.id);
    const nextMembers = members.listByRun(successor.id);
    const nextBuilder = nextMembers.find((member) => member.memberKey === 'builder:primary')!;
    expect(nextBuilder).toMatchObject({
      sessionId: 'session-b',
      priorMemberSessionId: priorMembers.find((member) => member.memberKey === 'builder:primary')!.id,
    });
    expect(nextMembers.find((member) => member.memberKey === 'reviewer:primary')?.sessionId).toBeNull();
    expect(runs.findById(prior.id)).toEqual(before);
  });

  it('allows only one nonterminal successor per task and returns the current run on conflict', async () => {
    const first = await service.create({ task, prior, profileSnapshot: snapshot, changeRequest: 'First' });
    try {
      await service.create({ task, prior, profileSnapshot: snapshot, changeRequest: 'Duplicate' });
      throw new Error('expected conflict');
    } catch (error) {
      expect(error).toBeInstanceOf(CrewRevisionConflictError);
      expect((error as CrewRevisionConflictError).current.id).toBe(first.id);
    }
    expect(runs.listByTask(task.id).filter((run) => run.status !== 'TERMINAL')).toHaveLength(1);
  });

  it('blocks changed/missing prior workspace instead of guessing or creating another worktree', async () => {
    boundary = { ...boundary, fullHead: 'b'.repeat(40) };
    await expect(service.create({ task, prior, profileSnapshot: snapshot, changeRequest: 'Unsafe' }))
      .rejects.toThrow('cannot be continued');
    expect(runs.listByTask(task.id)).toHaveLength(1);
  });
});
