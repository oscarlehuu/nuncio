import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CrewContextService } from '../../../src/crew/crew-context.service';
import { CrewMemberService } from '../../../src/crew/crew-member.service';
import { DatabaseService } from '../../../src/db/database.service';
import type { CrewProfileSnapshot } from '../../../src/crew/domain/crew.types';
import { ensureCrewSchema } from '../../../src/crew/persistence/crew-schema';
import { CrewArtifactsRepository } from '../../../src/crew/persistence/crew-artifacts.repository';
import { CrewEventsRepository } from '../../../src/crew/persistence/crew-events.repository';
import { CrewMembersRepository } from '../../../src/crew/persistence/crew-members.repository';
import { CrewRunsRepository } from '../../../src/crew/persistence/crew-runs.repository';
import { CrewTasksRepository } from '../../../src/crew/persistence/crew-tasks.repository';

const snapshot: CrewProfileSnapshot = {
  presetId: 'quality', sourceProfileId: 'p1', sourceProfileRevision: 1, resolvedAt: 1,
  bindings: {
    foreman: { provider: 'claude', model: 'fable', runtimePolicy: 'read-only' },
    builder: { provider: 'codex', model: 'sol', runtimePolicy: 'workspace-write' },
    reviewer: { provider: 'claude', model: 'opus', runtimePolicy: 'read-only' },
  }, tester: { kind: 'nuncio', runtimePolicy: 'read-only' },
  policy: { maxVerifyRetries: 2, maxReviewRetries: 2, strictFreshFinalReviewer: true, verifyCommand: null },
};

describe('CrewMemberService', () => {
  let dir: string;
  let database: DatabaseService;
  let runs: CrewRunsRepository;
  let members: CrewMembersRepository;
  let service: CrewMemberService;
  let runId: string;
  const attempts: Array<Record<string, unknown>> = [];
  let failNext: boolean;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nuncio-crew-member-'));
    process.env.NUNCIO_DATA_DIR = dir;
    database = new DatabaseService();
    ensureCrewSchema(database);
    const events = new CrewEventsRepository(database);
    runs = new CrewRunsRepository(database, events);
    members = new CrewMembersRepository(database);
    const task = new CrewTasksRepository(database).create({ objective: 'Ship', projectPath: '/repo' });
    let run = runs.create({ taskId: task.id, profileSnapshot: snapshot, projectPath: '/repo', context: {
      objective: 'Ship', constraints: [], decisions: [], doneCriteria: ['green'],
    } });
    run = runs.applyEvent(run.id, {
      expectedRevision: run.revision, idempotencyKey: 'workspace', actor: 'nuncio',
      event: { type: 'workspace_prepared', workspaceHead: 'a'.repeat(40) },
      workspace: { worktreePath: '/repo', branch: 'crew/run' },
    });
    runId = run.id;
    failNext = false;
    const execution = {
      startAttempt: async (input: Record<string, unknown>) => {
        attempts.push(input);
        if (failNext) throw new Error('simulated enqueue crash');
        const sessionId = (input.existingSessionId as string | null) ?? `session-${attempts.length}`;
        return { taskId: `task-${attempts.length}`, sessionId, continued: input.existingSessionId != null };
      },
      canResumeSession: async () => true,
    };
    const artifacts = new CrewArtifactsRepository(database);
    for (const kind of ['verify-log', 'workspace-diff']) artifacts.create({
      runId, kind, relativeStoragePath: `${runId}/${kind}.log`, sha256: kind, byteCount: 1,
      metadata: { workspaceHead: 'a'.repeat(40) },
    });
    service = new CrewMemberService(
      runs, members,
      new CrewContextService(runs, artifacts),
      execution as never,
    );
  });
  afterEach(() => {
    database.onModuleDestroy();
    rmSync(dir, { recursive: true, force: true });
    delete process.env.NUNCIO_DATA_DIR;
    attempts.length = 0;
  });

  it('binds snapshot provider/model and role-safe runtime policies exactly once', async () => {
    await service.enqueueAttempt(runId, 'foreman', 'Plan', 'plan-1');
    await service.enqueueAttempt(runId, 'builder', 'Build', 'build-1');
    await service.enqueueAttempt(runId, 'reviewer', 'Review', 'review-1');
    expect(attempts.map((attempt) => ({
      memberKey: attempt.memberKey, provider: attempt.provider, model: attempt.model,
      filesystem: (attempt.runtimePolicy as { filesystem: string }).filesystem,
    }))).toEqual([
      { memberKey: 'foreman:primary', provider: 'claude', model: 'fable', filesystem: 'read-only' },
      { memberKey: 'builder:primary', provider: 'codex', model: 'sol', filesystem: 'workspace-write' },
      { memberKey: 'reviewer:primary', provider: 'claude', model: 'opus', filesystem: 'read-only' },
    ]);
  });

  it('continues the exact Builder session across feedback attempts', async () => {
    const first = await service.enqueueAttempt(runId, 'builder', 'Build', 'build-1');
    const second = await service.enqueueAttempt(runId, 'builder', 'Fix verify', 'build-2');
    expect(first.member.sessionId).toBe('session-1');
    expect(second.member.id).toBe(first.member.id);
    expect(attempts[1]?.existingSessionId).toBe('session-1');
    expect(String(attempts[0]?.prompt)).toContain('"kind": "full"');
    expect(String(attempts[1]?.prompt)).toContain('"kind": "delta"');
  });

  it('creates a linked fresh final Reviewer only after the runner requests freshness', () => {
    const first = service.ensureMember(runId, 'reviewer');
    expect(service.ensureMember(runId, 'reviewer').id).toBe(first.id);
    const fresh = service.ensureMember(runId, 'reviewer', true);
    expect(fresh.id).not.toBe(first.id);
    expect(fresh.priorMemberSessionId).toBe(first.id);
    expect(members.listByRun(runId).filter((member) => member.isCurrent)).toHaveLength(1);
    expect(members.listByRun(runId)).toHaveLength(2);
  });

  it('puts exact current tool authority in the trusted member prompt on every attempt', async () => {
    const first = await service.enqueueAttempt(runId, 'foreman', 'Plan', 'plan-authority');
    const prompt = String(attempts[0]?.prompt);
    expect(prompt).toContain('"activeTool": "submit_plan"');
    expect(prompt).toContain(`"memberKey": "${first.member.memberKey}"`);
    expect(prompt).toContain(`"runId": "${runId}"`);
    expect(prompt).toContain('"workspaceHead": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"');
    expect(prompt).toContain('"readArtifactAuthority"');
    expect(prompt).toContain(':read');
    expect(prompt).not.toContain('browser_navigate');
    expect(prompt).not.toContain('enqueue_task');
  });

  it('sends full context to a fresh replacement and advances seen state only after delivery', async () => {
    const first = await service.enqueueAttempt(runId, 'builder', 'Build', 'build-first');
    expect(first.member.contextHealth).toBe('healthy');
    const fresh = service.ensureMember(runId, 'builder', true);
    expect(fresh).toMatchObject({ contextHealth: 'new', lastSeenContextRevision: 0 });
    failNext = true;
    await expect(service.enqueueAttempt(runId, 'builder', 'Recover', 'build-crash')).rejects.toThrow('enqueue crash');
    expect(members.findCurrent(runId, 'builder:primary')).toMatchObject({
      id: fresh.id, contextHealth: 'new', lastSeenContextRevision: 0,
    });
    failNext = false;
    await service.enqueueAttempt(runId, 'builder', 'Recover', 'build-retry');
    expect(String(attempts.at(-1)?.prompt)).toContain('"kind": "full"');
  });
});
