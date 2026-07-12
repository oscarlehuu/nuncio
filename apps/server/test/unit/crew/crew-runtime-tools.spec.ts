import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isCrewRuntimeToolAllowed } from '../../../src/agents/tools/agent-runtime-tools-policy';
import { CrewRuntimeToolsService } from '../../../src/crew/crew-runtime-tools.service';
import { CrewRuntimeMemberResolver } from '../../../src/crew/crew-runtime-member-resolver.service';
import { parseCrewSubmission } from '../../../src/crew/crew-runtime-tool.validate';
import { CrewWriterLeaseService } from '../../../src/crew/crew-writer-lease.service';
import { CrewArtifactStore } from '../../../src/crew/crew-artifact.store';
import { DatabaseService } from '../../../src/db/database.service';
import type { CrewProfileSnapshot } from '../../../src/crew/domain/crew.types';
import { ensureCrewSchema } from '../../../src/crew/persistence/crew-schema';
import { CrewEventsRepository } from '../../../src/crew/persistence/crew-events.repository';
import { CrewArtifactsRepository } from '../../../src/crew/persistence/crew-artifacts.repository';
import { CrewMembersRepository } from '../../../src/crew/persistence/crew-members.repository';
import { CrewResultsRepository } from '../../../src/crew/persistence/crew-results.repository';
import { CrewRunsRepository } from '../../../src/crew/persistence/crew-runs.repository';
import { CrewTasksRepository } from '../../../src/crew/persistence/crew-tasks.repository';
import { CrewWriterLeasesRepository } from '../../../src/crew/persistence/crew-writer-leases.repository';

const head = 'a'.repeat(40);
const nextHead = 'b'.repeat(40);
const snapshot: CrewProfileSnapshot = {
  presetId: 'quality', sourceProfileId: 'p1', sourceProfileRevision: 1, resolvedAt: 1,
  bindings: {
    foreman: { provider: 'claude', model: 'fable', runtimePolicy: 'read-only' },
    builder: { provider: 'codex', model: 'sol', runtimePolicy: 'workspace-write' },
    reviewer: { provider: 'claude', model: 'opus', runtimePolicy: 'read-only' },
  }, tester: { kind: 'nuncio', runtimePolicy: 'read-only' },
  policy: { maxVerifyRetries: 2, maxReviewRetries: 2, strictFreshFinalReviewer: true, verifyCommand: null },
};

describe('CrewRuntimeToolsService', () => {
  let dir: string;
  let database: DatabaseService;
  let runs: CrewRunsRepository;
  let members: CrewMembersRepository;
  let results: CrewResultsRepository;
  let leases: CrewWriterLeaseService;
  let runId: string;
  let source: CrewRuntimeToolsService;
  let registered: unknown;
  let taskById: Record<string, unknown> | null;
  let internalTasks: Array<Record<string, unknown>>;
  let sessionById: Record<string, unknown> | null;
  let boundaryHead: string;
  let checkpoint: ReturnType<typeof jest.fn>;
  let inspectBoundary: ReturnType<typeof jest.fn>;
  const submissions: unknown[] = [];
  const boundary = {
    ok: true, exists: true, symlink: false, canonicalPath: '/repo', branch: 'crew/run',
    fullHead: head, clean: true, reachable: true, reason: null,
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nuncio-crew-tools-'));
    process.env.NUNCIO_DATA_DIR = dir;
    database = new DatabaseService();
    ensureCrewSchema(database);
    const events = new CrewEventsRepository(database);
    runs = new CrewRunsRepository(database, events);
    members = new CrewMembersRepository(database);
    results = new CrewResultsRepository(database);
    leases = new CrewWriterLeaseService(new CrewWriterLeasesRepository(database));
    const task = new CrewTasksRepository(database).create({ objective: 'Ship', projectPath: '/repo' });
    let run = runs.create({ taskId: task.id, profileSnapshot: snapshot, projectPath: '/repo' });
    run = runs.applyEvent(run.id, {
      expectedRevision: run.revision, idempotencyKey: 'workspace', actor: 'nuncio',
      event: { type: 'workspace_prepared', workspaceHead: head },
      workspace: { worktreePath: '/repo', branch: 'crew/run' },
    });
    run = runs.applyEvent(run.id, {
      expectedRevision: run.revision, idempotencyKey: 'plan-start', actor: 'nuncio', event: { type: 'plan_started' },
    });
    runId = run.id;
    members.replaceCurrent({
      runId, memberKey: 'foreman:primary', provider: 'claude', model: 'fable', sessionId: 'session-1',
      priorMemberSessionId: null, lifecycle: 'active', contextHealth: 'healthy',
      lastSeenContextRevision: 0, lastSeenWorkspaceHead: head, lastUsedAt: 1,
    });
    const registry = { registerSource: (value: unknown) => { registered = value; return () => { registered = undefined; }; } };
    taskById = null;
    internalTasks = [];
    sessionById = null;
    boundaryHead = head;
    checkpoint = jest.fn(async () => {
      boundaryHead = nextHead;
      return { fullHead: nextHead, clean: true, committed: true };
    });
    inspectBoundary = jest.fn(async () => ({ ...boundary, fullHead: boundaryHead }));
    const artifactStore = new CrewArtifactStore(database, new CrewArtifactsRepository(database));
    const taskSource = { listInternal: () => internalTasks, findById: () => taskById };
    const sessionSource = { get: () => sessionById };
    source = new CrewRuntimeToolsService(
      registry as never,
      new CrewRuntimeMemberResolver(taskSource as never, sessionSource as never, runs, members),
      runs,
      members,
      results,
      artifactStore,
      leases,
      {
        inspectBoundary,
        checkpoint,
      } as never,
    );
    source.setSubmissionSink((submission) => { submissions.push(submission); });
    source.onModuleInit();
  });
  afterEach(() => {
    source.onModuleDestroy();
    database.onModuleDestroy();
    rmSync(dir, { recursive: true, force: true });
    delete process.env.NUNCIO_DATA_DIR;
    submissions.length = 0;
  });

  it('registers a trusted stable Foreman tool surface and persists duplicate submissions once', async () => {
    expect(registered).toBe(source);
    const tools = source.forSession({ sessionId: 'session-1', projectPath: '/repo' })!;
    expect(tools.tools.map((tool) => tool.name)).toEqual([
      'submit_plan', 'submit_synthesis', 'read_crew_artifact',
    ]);
    const submit = tools.tools[0]!;
    const properties = submit.inputSchema.properties as Record<string, { type?: unknown; const?: unknown }>;
    expect(properties.runId).toMatchObject({ type: 'string' });
    expect(properties.memberKey).toMatchObject({ type: 'string' });
    expect(JSON.stringify(submit.inputSchema)).not.toContain('"const"');
    expect(tools.tools.filter((tool) => tool.testInput?.())).toHaveLength(1);
    expect(isCrewRuntimeToolAllowed(submit, {
      filesystem: 'read-only', workspaceRoot: '/repo', network: 'disabled',
    })).toBe(true);
    const input = toolInput('session-1', 'plan', { summary: 'Plan', steps: ['Build'], openQuestions: [] });
    await submit.execute(input);
    await submit.execute(input);
    expect(results.listByRun(runId)).toHaveLength(1);
    expect(submissions).toHaveLength(1);
  });

  it('revalidates forged scope fields even though the stable schema cannot bind live values', async () => {
    const submit = source.forSession({ sessionId: 'session-1', projectPath: '/repo' })!.tools[0]!;
    const input = toolInput('session-1', 'plan', { summary: 'Plan', steps: [], openQuestions: [] });
    input.runId = 'forged';
    await expect(submit.execute(input)).rejects.toThrow('scope');
  });

  it.each(['pause_requested', 'cancel_requested'] as const)(
    'rechecks authority after the async boundary when %s races submission', async (type) => {
      let release!: (value: typeof boundary) => void;
      inspectBoundary.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
      const submit = source.forSession({ sessionId: 'session-1', projectPath: '/repo' })!.tools[0]!;
      const pending = submit.execute(toolInput('session-1', 'plan', {
        summary: 'Late plan', steps: [], openQuestions: [],
      }));
      await Promise.resolve();
      const run = runs.findById(runId)!;
      runs.applyEvent(runId, {
        expectedRevision: run.revision, idempotencyKey: `race:${type}`, actor: 'user', event: { type },
      });
      release(boundary);
      await expect(pending).rejects.toThrow('stale');
      expect(results.listByRun(runId)).toHaveLength(0);
    },
  );

  it('rejects oversized aggregate structured evidence instead of persisting megabytes', () => {
    expect(() => parseCrewSubmission('review', {
      summary: 'Review',
      findings: Array.from({ length: 20 }, (_, index) => ({
        severity: 'warning', title: `Finding ${index}`, body: 'x'.repeat(16_384),
      })),
    }, head)).toThrow('262144');
  });

  it('persists a head-A build intent without checkpointing before the member turn settles', async () => {
    let run = runs.findById(runId)!;
    run = runs.applyEvent(runId, {
      expectedRevision: run.revision, idempotencyKey: 'plan-accepted', actor: 'nuncio',
      event: { type: 'plan_accepted' },
    });
    run = runs.applyEvent(runId, {
      expectedRevision: run.revision, idempotencyKey: 'builder-claimed', actor: 'nuncio',
      event: { type: 'builder_claimed' },
    });
    const builder = members.replaceCurrent({
      runId, memberKey: 'builder:primary', provider: 'codex', model: 'sol', sessionId: 'builder-session',
      priorMemberSessionId: null, lifecycle: 'active', contextHealth: 'healthy',
      lastSeenContextRevision: run.contextRevision, lastSeenWorkspaceHead: head, lastUsedAt: 1,
    });
    leases.acquire({
      runId, memberSessionId: builder.id, memberKey: builder.memberKey, startingHead: head,
    });
    const submit = source.forSession({ sessionId: 'builder-session', projectPath: '/repo' })!.tools[0]!;
    const input = toolInput('builder-session', 'build', {
      summary: 'Built', changedFiles: ['src/a.ts'],
    });
    await submit.execute(input);
    expect(results.listByRun(runId).at(-1)?.result).toMatchObject({
      kind: 'builder-intent', basedOnWorkspaceHead: head,
    });
    expect(checkpoint).not.toHaveBeenCalled();
    expect(leases.get(runId)).not.toBeNull();
  });

  it('correlates the first provider turn through Session originTaskId before task.sessionId attaches', () => {
    const current = members.findCurrent(runId, 'foreman:primary')!;
    members.replaceCurrent({
      runId, memberKey: 'foreman:primary', provider: current.provider, model: current.model,
      sessionId: null, priorMemberSessionId: current.id, lifecycle: 'active', contextHealth: 'healthy',
      lastSeenContextRevision: 0, lastSeenWorkspaceHead: head, lastUsedAt: 2,
    });
    sessionById = { id: 'first-turn', originTaskId: 'task-first-turn' };
    taskById = {
      id: 'task-first-turn', executionKind: 'crew-member', crewRunId: runId,
      crewMemberKey: 'foreman:primary', sessionId: null, status: 'RUNNING',
      crewAttemptKey: `runner:plan:attempt:${runs.findById(runId)!.revision}`,
    };
    expect(source.forSession({ sessionId: 'first-turn', projectPath: '/repo' })?.tools[0]?.name)
      .toBe('submit_plan');
    expect(members.findBySessionId('first-turn')?.memberKey).toBe('foreman:primary');
  });

  it('keeps the structured build intent durable while later provider edits remain uncheckpointed', async () => {
    let run = runs.findById(runId)!;
    run = runs.applyEvent(runId, {
      expectedRevision: run.revision, idempotencyKey: 'plan-accepted-crash', actor: 'nuncio',
      event: { type: 'plan_accepted' },
    });
    run = runs.applyEvent(runId, {
      expectedRevision: run.revision, idempotencyKey: 'builder-claimed-crash', actor: 'nuncio',
      event: { type: 'builder_claimed' },
    });
    const builder = members.replaceCurrent({
      runId, memberKey: 'builder:primary', provider: 'codex', model: 'sol', sessionId: 'crash-session',
      priorMemberSessionId: null, lifecycle: 'active', contextHealth: 'healthy',
      lastSeenContextRevision: run.contextRevision, lastSeenWorkspaceHead: head, lastUsedAt: 1,
    });
    leases.acquire({ runId, memberSessionId: builder.id, memberKey: builder.memberKey, startingHead: head });
    const submit = source.forSession({ sessionId: 'crash-session', projectPath: '/repo' })!.tools[0]!;
    await submit.execute(toolInput('crash-session', 'build', {
      summary: 'Built before later edit', changedFiles: ['src/crash.ts'],
    }));
    expect(checkpoint).not.toHaveBeenCalled();
    expect(boundaryHead).toBe(head);
    expect(results.listByRun(runId)[0]?.result).toMatchObject({
      kind: 'builder-intent', basedOnWorkspaceHead: head,
    });
    expect(leases.get(runId)).not.toBeNull();
  });

  it('prefers the active successor Task when one provider session id exists in prior and current runs', () => {
    const taskRepo = new CrewTasksRepository(database);
    const oldTask = taskRepo.create({ objective: 'Old', projectPath: '/repo' });
    let oldRun = runs.create({ taskId: oldTask.id, profileSnapshot: snapshot, projectPath: '/repo' });
    oldRun = runs.applyEvent(oldRun.id, {
      expectedRevision: oldRun.revision, idempotencyKey: 'old-workspace', actor: 'test',
      event: { type: 'workspace_prepared', workspaceHead: head },
      workspace: { worktreePath: '/repo', branch: 'crew/run' },
    });
    oldRun = runs.applyEvent(oldRun.id, {
      expectedRevision: oldRun.revision, idempotencyKey: 'old-plan', actor: 'test', event: { type: 'plan_started' },
    });
    members.replaceCurrent({
      runId: oldRun.id, memberKey: 'foreman:primary', provider: 'claude', model: 'fable', sessionId: 'session-1',
      priorMemberSessionId: null, lifecycle: 'active', contextHealth: 'healthy',
      lastSeenContextRevision: 0, lastSeenWorkspaceHead: head, lastUsedAt: 1,
    });
    sessionById = { id: 'session-1', originTaskId: 'prior-origin-task' };
    taskById = {
      id: 'prior-origin-task', executionKind: 'crew-member', status: 'DONE', sessionId: 'session-1',
      crewRunId: oldRun.id, crewMemberKey: 'foreman:primary',
    };
    internalTasks = [{
      executionKind: 'crew-member', status: 'RUNNING', sessionId: 'session-1', crewRunId: runId,
      crewMemberKey: 'foreman:primary',
      crewAttemptKey: `runner:plan:attempt:${runs.findById(runId)!.revision}`,
    }];
    const active = source.forSession({ sessionId: 'session-1', projectPath: '/repo' })!.tools
      .find((tool) => tool.name === 'submit_plan')!;
    expect(active.testInput?.()).toMatchObject({ runId, memberKey: 'foreman:primary' });
  });

  it('never lets a terminal old session hijack the current replacement member', () => {
    const prior = members.findCurrent(runId, 'foreman:primary')!;
    const replacement = members.replaceCurrent({
      runId, memberKey: 'foreman:primary', provider: prior.provider, model: prior.model,
      sessionId: 'replacement-session', priorMemberSessionId: prior.id, lifecycle: 'active',
      contextHealth: 'healthy', lastSeenContextRevision: 0, lastSeenWorkspaceHead: head, lastUsedAt: 2,
    });
    sessionById = { id: 'session-1', originTaskId: 'old-terminal-task' };
    taskById = {
      id: 'old-terminal-task', executionKind: 'crew-member', status: 'DONE', sessionId: 'session-1',
      crewRunId: runId, crewMemberKey: 'foreman:primary', crewAttemptKey: 'runner:plan:attempt:1',
    };
    expect(source.forSession({ sessionId: 'session-1', projectPath: '/repo' })).toBeUndefined();
    expect(members.findCurrent(runId, 'foreman:primary')).toMatchObject({
      id: replacement.id, sessionId: 'replacement-session',
    });
  });

  function toolInput(sessionId: string, kind: 'plan' | 'build', result: Record<string, unknown>) {
    const run = runs.findById(runId)!;
    const member = members.findBySessionId(sessionId)!;
    return {
      runId, memberKey: member.memberKey, contextRevision: run.contextRevision,
      workspaceHead: run.workspaceHead!,
      idempotencyKey: `crew:${runId}:${run.revision}:${member.id}:${kind}`,
      result,
    };
  }
});
