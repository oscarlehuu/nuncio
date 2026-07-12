import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseService } from '../../../src/db/database.service';
import type { CrewProfileSnapshot } from '../../../src/crew/domain/crew.types';
import { CrewEventsRepository } from '../../../src/crew/persistence/crew-events.repository';
import { CrewRunsRepository } from '../../../src/crew/persistence/crew-runs.repository';
import { ensureCrewSchema } from '../../../src/crew/persistence/crew-schema';
import { CrewTasksRepository } from '../../../src/crew/persistence/crew-tasks.repository';

const snapshot: CrewProfileSnapshot = {
  presetId: 'quality', sourceProfileId: 'profile', sourceProfileRevision: 1, resolvedAt: 1,
  bindings: {
    foreman: { provider: 'mock', model: 'foreman', runtimePolicy: 'read-only' },
    builder: { provider: 'mock', model: 'builder', runtimePolicy: 'workspace-write' },
    reviewer: { provider: 'mock', model: 'reviewer', runtimePolicy: 'read-only' },
  },
  tester: { kind: 'nuncio', runtimePolicy: 'read-only' },
  policy: {
    maxVerifyRetries: 2, maxReviewRetries: 2,
    strictFreshFinalReviewer: true, verifyCommand: 'true',
  },
};

describe('Crew run summaries', () => {
  let dataDir: string;
  let database: DatabaseService;
  let tasks: CrewTasksRepository;
  let runs: CrewRunsRepository;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-crew-summary-'));
    process.env.NUNCIO_DATA_DIR = dataDir;
    database = new DatabaseService();
    ensureCrewSchema(database);
    tasks = new CrewTasksRepository(database);
    runs = new CrewRunsRepository(database, new CrewEventsRepository(database));
  });

  afterEach(() => {
    database.onModuleDestroy();
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.NUNCIO_DATA_DIR;
  });

  it('returns only the latest run per task and excludes private/full-run fields', () => {
    const task = tasks.create({ objective: 'Latest objective', projectPath: '/repo-a' });
    const first = runs.create({ taskId: task.id, profileSnapshot: snapshot, projectPath: task.projectPath });
    const terminal = runs.applyEvent(first.id, {
      expectedRevision: first.revision, idempotencyKey: 'cancel-first', actor: 'test',
      event: { type: 'cancel_requested' },
    });
    const latest = runs.create({
      taskId: task.id, priorRunId: terminal.id, profileSnapshot: snapshot,
      projectPath: task.projectPath,
    });

    const summaries = runs.listSummaries({ limit: 10, offset: 0 });
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({
      id: latest.id, taskId: task.id, objective: task.objective,
      phase: latest.phase, status: latest.status,
    });
    expect(Object.keys(summaries[0]!).sort()).toEqual([
      'blockedReason', 'createdAt', 'id', 'objective', 'outcome', 'phase',
      'revision', 'status', 'taskId', 'updatedAt', 'workspaceHead',
    ]);
  });

  it('paginates the newest task summaries and applies filters to current runs only', () => {
    const created = ['/repo-a', '/repo-a', '/repo-b'].map((projectPath, index) => {
      const task = tasks.create({ objective: `Task ${index}`, projectPath });
      const run = runs.create({ taskId: task.id, profileSnapshot: snapshot, projectPath });
      database.db.prepare('UPDATE crew_runs SET updated_at = ? WHERE id = ?').run(100 + index, run.id);
      return { task, run };
    });

    const firstPage = runs.listSummaries({ limit: 2, offset: 0 });
    const secondPage = runs.listSummaries({ limit: 2, offset: 2 });
    expect(firstPage.map((run) => run.taskId)).toEqual([created[2]!.task.id, created[1]!.task.id]);
    expect(secondPage.map((run) => run.taskId)).toEqual([created[0]!.task.id]);
    expect(runs.listSummaries({ projectPath: '/repo-a', status: 'QUEUED', limit: 10, offset: 0 }))
      .toHaveLength(2);
    expect(runs.listSummaries({ status: 'TERMINAL', limit: 10, offset: 0 })).toEqual([]);
  });
});
