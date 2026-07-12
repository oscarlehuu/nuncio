import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseService } from '../../../src/db/database.service';
import { ensureCrewSchema } from '../../../src/crew/persistence/crew-schema';
import { CrewProfilesRepository } from '../../../src/crew/persistence/crew-profiles.repository';
import { CrewTasksRepository } from '../../../src/crew/persistence/crew-tasks.repository';
import { CrewRunsRepository } from '../../../src/crew/persistence/crew-runs.repository';
import { CrewEventsRepository } from '../../../src/crew/persistence/crew-events.repository';
import { CrewMembersRepository } from '../../../src/crew/persistence/crew-members.repository';
import { CrewResultsRepository } from '../../../src/crew/persistence/crew-results.repository';
import { CrewArtifactsRepository } from '../../../src/crew/persistence/crew-artifacts.repository';
import { CrewWriterLeasesRepository } from '../../../src/crew/persistence/crew-writer-leases.repository';
import { CrewRevisionConflictError } from '../../../src/crew/domain/crew-errors';
import type { CrewProfileSnapshot } from '../../../src/crew/domain/crew.types';

const snapshot: CrewProfileSnapshot = {
  presetId: 'quality', sourceProfileId: 'profile-1', sourceProfileRevision: 1, resolvedAt: 1,
  bindings: {
    foreman: { provider: 'claude', model: 'fable', runtimePolicy: 'read-only' },
    builder: { provider: 'codex', model: 'sol', runtimePolicy: 'workspace-write' },
    reviewer: { provider: 'claude', model: 'opus', runtimePolicy: 'read-only' },
  },
  tester: { kind: 'nuncio', runtimePolicy: 'read-only' },
  policy: {
    maxVerifyRetries: 2, maxReviewRetries: 2, strictFreshFinalReviewer: true, verifyCommand: null,
  },
};

describe('Crew repositories', () => {
  let database: DatabaseService;
  let dataDir: string;
  let profiles: CrewProfilesRepository;
  let tasks: CrewTasksRepository;
  let runs: CrewRunsRepository;
  let events: CrewEventsRepository;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-crew-'));
    process.env.NUNCIO_DATA_DIR = dataDir;
    database = new DatabaseService();
    ensureCrewSchema(database);
    profiles = new CrewProfilesRepository(database);
    tasks = new CrewTasksRepository(database);
    events = new CrewEventsRepository(database);
    runs = new CrewRunsRepository(database, events);
  });

  afterEach(() => {
    database.onModuleDestroy();
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.NUNCIO_DATA_DIR;
  });

  it('creates every Crew table and remains idempotent on an existing database', () => {
    ensureCrewSchema(database);
    const tables = database.db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'crew_%' ORDER BY name",
    ).all() as Array<{ name: string }>;
    expect(tables.map(({ name }) => name)).toEqual([
      'crew_artifacts', 'crew_events', 'crew_member_results', 'crew_member_sessions',
      'crew_profiles', 'crew_runs', 'crew_tasks', 'crew_writer_leases',
    ]);
  });

  it('persists mutable profile revisions with positional parameters', () => {
    const profile = profiles.create({ name: "Oscar's Quality", presetId: 'quality', definition: snapshot });
    expect(profile).toMatchObject({ name: "Oscar's Quality", revision: 1 });
    const updated = profiles.update(profile.id, profile.revision, {
      name: 'Quality v2', definition: { ...snapshot, resolvedAt: 2 },
    });
    expect(updated).toMatchObject({ name: 'Quality v2', revision: 2 });
  });

  it('creates an immutable run snapshot and a prior-run successor link', () => {
    const frozenBaseHead = 'a'.repeat(40);
    const task = tasks.create({ objective: 'Ship Crew', projectPath: '/tmp/repo', baseBranch: 'dev' });
    let first = runs.create({
      taskId: task.id, profileSnapshot: snapshot, projectPath: task.projectPath,
      baseBranch: 'dev', baseHead: frozenBaseHead,
    });
    expect(new CrewRunsRepository(database, new CrewEventsRepository(database)).findById(first.id))
      .toMatchObject({ baseBranch: 'dev', baseHead: frozenBaseHead });
    first = runs.applyEvent(first.id, {
      expectedRevision: first.revision, idempotencyKey: 'terminal-prior', actor: 'test',
      event: { type: 'cancel_requested' },
    });
    const successor = runs.create({
      taskId: task.id, priorRunId: first.id, profileSnapshot: { ...snapshot, resolvedAt: 2 },
      projectPath: task.projectPath, baseBranch: 'dev',
    });
    expect(first.profileSnapshot.resolvedAt).toBe(1);
    expect(successor.priorRunId).toBe(first.id);
    expect(tasks.findById(task.id)).toEqual(task);
  });

  it('appends event + CAS projection atomically and replays to the stored projection', () => {
    const task = tasks.create({ objective: 'Ship Crew', projectPath: '/tmp/repo' });
    let run = runs.create({ taskId: task.id, profileSnapshot: snapshot, projectPath: task.projectPath });
    run = runs.applyEvent(run.id, {
      expectedRevision: run.revision, idempotencyKey: 'plan-start', actor: 'nuncio',
      event: { type: 'plan_started' },
    });
    run = runs.applyEvent(run.id, {
      expectedRevision: run.revision, idempotencyKey: 'plan-accepted', actor: 'foreman',
      event: { type: 'plan_accepted' },
    });
    expect(events.list(run.id, 0).map((event) => event.seq)).toEqual([1, 2, 3]);
    expect(runs.replay(run.id)).toMatchObject({
      phase: run.phase, status: run.status, revision: run.revision,
    });
  });

  it('notifies listeners once after a new event commits, never for an idempotent replay', () => {
    const task = tasks.create({ objective: 'Ship Crew', projectPath: '/tmp/repo' });
    const run = runs.create({ taskId: task.id, profileSnapshot: snapshot, projectPath: task.projectPath });
    const changes: Array<{ revision: number; type: string }> = [];
    const unsubscribe = runs.onChanged((changed, event) => {
      changes.push({ revision: changed.revision, type: event.type });
    });
    const input = {
      expectedRevision: run.revision, idempotencyKey: 'notify-plan', actor: 'nuncio',
      event: { type: 'plan_started' as const },
    };

    const advanced = runs.applyEvent(run.id, input);
    runs.applyEvent(run.id, input);
    unsubscribe();
    runs.applyEvent(run.id, {
      expectedRevision: advanced.revision, idempotencyKey: 'notify-plan-accepted', actor: 'foreman',
      event: { type: 'plan_accepted' },
    });

    expect(changes).toEqual([{ revision: advanced.revision, type: 'plan_started' }]);
  });

  it('deduplicates idempotency keys before stale-revision checks', () => {
    const task = tasks.create({ objective: 'Ship Crew', projectPath: '/tmp/repo' });
    const run = runs.create({ taskId: task.id, profileSnapshot: snapshot, projectPath: task.projectPath });
    const advanced = runs.applyEvent(run.id, {
      expectedRevision: run.revision, idempotencyKey: 'same', actor: 'nuncio',
      event: { type: 'plan_started' },
    });
    const duplicate = runs.applyEvent(run.id, {
      expectedRevision: run.revision, idempotencyKey: 'same', actor: 'nuncio',
      event: { type: 'plan_started' },
    });
    expect(duplicate.revision).toBe(advanced.revision);
    expect(events.list(run.id, 0)).toHaveLength(2);
  });

  it('rejects stale CAS and rolls back an invalid transition without an event', () => {
    const task = tasks.create({ objective: 'Ship Crew', projectPath: '/tmp/repo' });
    const run = runs.create({ taskId: task.id, profileSnapshot: snapshot, projectPath: task.projectPath });
    expect(() => runs.applyEvent(run.id, {
      expectedRevision: 0, idempotencyKey: 'stale', actor: 'nuncio', event: { type: 'plan_started' },
    })).toThrow(CrewRevisionConflictError);
    expect(() => runs.applyEvent(run.id, {
      expectedRevision: run.revision, idempotencyKey: 'illegal', actor: 'nuncio',
      event: { type: 'verify_passed', basedOnWorkspaceHead: 'missing' },
    })).toThrow();
    expect(events.list(run.id, 0)).toHaveLength(1);
    expect(runs.findById(run.id)?.revision).toBe(run.revision);
  });

  it('retains historical member incarnations while allowing one current member per key', () => {
    const task = tasks.create({ objective: 'Ship Crew', projectPath: '/tmp/repo' });
    const run = runs.create({ taskId: task.id, profileSnapshot: snapshot, projectPath: task.projectPath });
    const members = new CrewMembersRepository(database);
    const first = members.replaceCurrent({
      runId: run.id, memberKey: 'reviewer:primary', provider: 'claude', model: 'opus',
      sessionId: 'session-1', priorMemberSessionId: null, lifecycle: 'idle-reusable',
      contextHealth: 'healthy', lastSeenContextRevision: 0, lastSeenWorkspaceHead: null, lastUsedAt: 1,
    });
    members.replaceCurrent({
      runId: run.id, memberKey: 'reviewer:primary', provider: 'claude', model: 'opus',
      sessionId: 'session-2', priorMemberSessionId: first.id, lifecycle: 'active',
      contextHealth: 'healthy', lastSeenContextRevision: 1, lastSeenWorkspaceHead: 'head-1', lastUsedAt: 2,
    });
    const history = members.listByRun(run.id);
    expect(history).toHaveLength(2);
    expect(history.filter((member) => member.isCurrent)).toHaveLength(1);
    expect(history.find((member) => member.id === first.id)?.isCurrent).toBe(false);
  });

  it('persists immutable results/artifact metadata and enforces one writer lease per run', () => {
    const task = tasks.create({ objective: 'Ship Crew', projectPath: '/tmp/repo' });
    const run = runs.create({ taskId: task.id, profileSnapshot: snapshot, projectPath: task.projectPath });
    const results = new CrewResultsRepository(database);
    const artifacts = new CrewArtifactsRepository(database);
    const leases = new CrewWriterLeasesRepository(database);
    const result = results.create({
      runId: run.id, memberSessionId: 'member-1', phase: 'BUILD', attempt: 1,
      result: {
        kind: 'builder', summary: 'done', changedFiles: ['a.ts'],
        basedOnWorkspaceHead: 'head-0', commitHead: 'head-1',
      },
      basedOnContextRevision: 1, workspaceHead: 'head-1',
    });
    const artifact = artifacts.create({
      runId: run.id, kind: 'verify-log', relativeStoragePath: 'logs/verify.txt', sha256: 'abc',
      byteCount: 3, metadata: { command: 'bun test' },
    });
    const lease = leases.acquire({
      runId: run.id, memberSessionId: 'member-1', taskId: null, token: 'lease-1', startingHead: null,
    });
    expect(results.listByRun(run.id)).toEqual([result]);
    expect(artifacts.listByRun(run.id)).toEqual([artifact]);
    expect(leases.get(run.id)).toEqual(lease);
    expect(() => leases.acquire({ ...lease, memberSessionId: 'member-2', token: 'lease-2' })).toThrow();
    expect(leases.release(run.id, 'wrong-token')).toBe(false);
    expect(leases.release(run.id, 'lease-1')).toBe(true);
    expect(() => artifacts.create({
      runId: run.id, kind: 'bad', relativeStoragePath: '../secret', sha256: 'x', byteCount: 1, metadata: {},
    })).toThrow('run-relative');
  });
});
