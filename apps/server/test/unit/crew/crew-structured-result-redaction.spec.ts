import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CrewArtifactStore } from '../../../src/crew/crew-artifact.store';
import { CrewContextService } from '../../../src/crew/crew-context.service';
import { CrewRunQueryService } from '../../../src/crew/crew-run-query.service';
import { parseCrewSubmission } from '../../../src/crew/crew-runtime-tool.validate';
import { CrewStageResultsService } from '../../../src/crew/crew-stage-results.service';
import type { CrewProfileSnapshot } from '../../../src/crew/domain/crew.types';
import { CrewArtifactsRepository } from '../../../src/crew/persistence/crew-artifacts.repository';
import { CrewEventsRepository } from '../../../src/crew/persistence/crew-events.repository';
import { CrewMembersRepository } from '../../../src/crew/persistence/crew-members.repository';
import { CrewResultsRepository } from '../../../src/crew/persistence/crew-results.repository';
import { CrewRunsRepository } from '../../../src/crew/persistence/crew-runs.repository';
import { ensureCrewSchema } from '../../../src/crew/persistence/crew-schema';
import { CrewTasksRepository } from '../../../src/crew/persistence/crew-tasks.repository';
import { DatabaseService } from '../../../src/db/database.service';

const head = 'a'.repeat(40);
const token = `sk-proj-${'z'.repeat(32)}`;
const snapshot: CrewProfileSnapshot = {
  presetId: 'quality', sourceProfileId: 'profile', sourceProfileRevision: 1, resolvedAt: 1,
  bindings: {
    foreman: { provider: 'mock', model: 'foreman', runtimePolicy: 'read-only' },
    builder: { provider: 'mock', model: 'builder', runtimePolicy: 'workspace-write' },
    reviewer: { provider: 'mock', model: 'reviewer', runtimePolicy: 'read-only' },
  },
  tester: { kind: 'nuncio', runtimePolicy: 'read-only' },
  policy: {
    maxVerifyRetries: 1, maxReviewRetries: 1, strictFreshFinalReviewer: true,
    verifyCommand: 'true',
  },
};

describe('Crew structured result redaction', () => {
  it('redacts every model-authored prose field while preserving path identifiers', () => {
    const exactPath = ' path with spaces.ts ';
    const results = [
      parseCrewSubmission('plan', {
        summary: `summary ${token}`, steps: [`step ${token}`],
        openQuestions: [`question ${token}`], materialClarification: `clarify ${token}`,
      }, head),
      parseCrewSubmission('build', {
        summary: `build ${token}`, changedFiles: [exactPath],
      }, head),
      parseCrewSubmission('review', {
        summary: `review ${token}`,
        findings: [{
          severity: 'blocker', title: `title ${token}`, body: `body ${token}`,
          file: exactPath, line: 7,
        }],
      }, head),
      parseCrewSubmission('synthesis', {
        summary: `synthesis ${token}`, verification: `verify ${token}`,
        remainingRisks: [`risk ${token}`],
      }, head),
    ];

    expect(JSON.stringify(results)).not.toContain(token);
    expect(JSON.stringify(results)).toContain('[REDACTED]');
    expect(results[1]).toMatchObject({ changedFiles: [exactPath] });
    expect(results[2]).toMatchObject({ findings: [{ file: exactPath }] });
  });

  it('keeps submitted secrets out of result storage, projected context, and API detail', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'crew-result-redaction-'));
    process.env.NUNCIO_DATA_DIR = dir;
    const db = new DatabaseService();
    try {
      ensureCrewSchema(db);
      const events = new CrewEventsRepository(db);
      const runs = new CrewRunsRepository(db, events);
      const members = new CrewMembersRepository(db);
      const results = new CrewResultsRepository(db);
      const artifacts = new CrewArtifactsRepository(db);
      const task = new CrewTasksRepository(db).create({ objective: 'Ship', projectPath: '/source' });
      let run = runs.create({ taskId: task.id, profileSnapshot: snapshot, projectPath: '/source' });
      run = runs.applyEvent(run.id, {
        expectedRevision: run.revision, idempotencyKey: 'workspace', actor: 'test',
        event: { type: 'workspace_prepared', workspaceHead: head },
        workspace: { worktreePath: '/worktree', branch: 'crew/run' },
      });
      run = runs.applyEvent(run.id, {
        expectedRevision: run.revision, idempotencyKey: 'plan-start', actor: 'test',
        event: { type: 'plan_started' },
      });
      const parsed = parseCrewSubmission('plan', {
        summary: `plan ${token}`, steps: [`build ${token}`],
        openQuestions: [`question ${token}`],
      }, head);
      const persisted = results.createIdempotent({
        runId: run.id, memberSessionId: 'foreman', phase: 'PLAN', attempt: 1,
        result: parsed, basedOnContextRevision: run.contextRevision, workspaceHead: head,
      }, 'submitted-plan').result;
      await new CrewStageResultsService(runs, { assertCurrent: async () => undefined } as never)
        .accept({ runId: run.id, memberKey: 'foreman:primary', kind: 'plan', result: persisted, workspaceHead: head });

      const store = new CrewArtifactStore(db, artifacts);
      const context = new CrewContextService(runs, artifacts, results)
        .buildEnvelope(run.id, 'builder', 'Build the accepted plan');
      const apiDetail = new CrewRunQueryService(
        runs, events, members, results, artifacts, { items: () => [] } as never, store,
      ).detail(run.id);

      for (const payload of [results.listByRun(run.id), context, apiDetail]) {
        expect(JSON.stringify(payload)).not.toContain(token);
        expect(JSON.stringify(payload)).toContain('[REDACTED]');
      }
    } finally {
      db.onModuleDestroy();
      rmSync(dir, { recursive: true, force: true });
      delete process.env.NUNCIO_DATA_DIR;
    }
  });
});
