import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CrewStageResultsService } from '../../../src/crew/crew-stage-results.service';
import { DatabaseService } from '../../../src/db/database.service';
import type { CrewMemberResult } from '../../../src/crew/domain/crew-results';
import type { CrewProfileSnapshot, CrewRunDto } from '../../../src/crew/domain/crew.types';
import { ensureCrewSchema } from '../../../src/crew/persistence/crew-schema';
import { CrewEventsRepository } from '../../../src/crew/persistence/crew-events.repository';
import { CrewResultsRepository } from '../../../src/crew/persistence/crew-results.repository';
import { CrewRunsRepository } from '../../../src/crew/persistence/crew-runs.repository';
import { CrewTasksRepository } from '../../../src/crew/persistence/crew-tasks.repository';

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

describe('CrewStageResultsService', () => {
  let dir: string; let db: DatabaseService; let runs: CrewRunsRepository;
  let results: CrewResultsRepository; let service: CrewStageResultsService; let run: CrewRunDto;
  const assertCurrent = jest.fn(async () => {});
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'crew-stage-results-'));
    process.env.NUNCIO_DATA_DIR = dir;
    db = new DatabaseService(); ensureCrewSchema(db);
    runs = new CrewRunsRepository(db, new CrewEventsRepository(db));
    results = new CrewResultsRepository(db);
    const task = new CrewTasksRepository(db).create({ objective: 'Ship', projectPath: '/source' });
    run = runs.create({ taskId: task.id, profileSnapshot: snapshot, projectPath: '/source' });
    run = apply({ type: 'workspace_prepared', workspaceHead: headA }, 'workspace', {
      worktreePath: '/worktree', branch: 'nuncio/run-ship', baseBranch: 'main',
    });
    run = apply({ type: 'plan_started' }, 'plan-start');
    service = new CrewStageResultsService(runs, { assertCurrent } as never);
    assertCurrent.mockClear();
  });
  afterEach(() => {
    db.onModuleDestroy(); rmSync(dir, { recursive: true, force: true }); delete process.env.NUNCIO_DATA_DIR;
  });

  it('accepts structured Plan once and persists its shared context revision atomically', async () => {
    const notice = persist('PLAN', 'foreman', {
      kind: 'plan', summary: 'Plan', steps: ['Build'], openQuestions: [],
    });
    const accepted = await service.accept(notice);
    expect(accepted).toMatchObject({ phase: 'BUILD', status: 'QUEUED', contextRevision: 1 });
    expect(accepted.context).toMatchObject({ planSummary: 'Plan', planSteps: ['Build'] });
    expect((await service.accept(notice)).revision).toBe(accepted.revision);
  });

  it('blocks for material clarification and records the question in shared context', async () => {
    const blocked = await service.accept(persist('PLAN', 'foreman', {
      kind: 'plan', summary: 'Need choice', steps: [], openQuestions: ['Public API?'],
      materialClarification: 'Choose the public API',
    }));
    expect(blocked).toMatchObject({ status: 'BLOCKED_USER', contextRevision: 1 });
    expect(blocked.context).toMatchObject({ pendingClarification: 'Choose the public API' });
  });

  it('routes final Builder evidence to VERIFY using actual checkpoint head B', async () => {
    run = apply({ type: 'plan_accepted' }, 'plan-pass');
    run = apply({ type: 'builder_claimed' }, 'builder-start');
    const built = await service.accept(persist('BUILD', 'builder', {
      kind: 'builder', summary: 'Built', changedFiles: ['src/a.ts'],
      basedOnWorkspaceHead: headA, commitHead: headB,
    }, headB));
    expect(built).toMatchObject({ phase: 'VERIFY', workspaceHead: headB, contextRevision: 2 });
  });

  it('passes review warnings but routes blockers back to Builder with monotonic feedback context', async () => {
    run = toReview();
    const warning = await service.accept(persist('REVIEW', 'reviewer', {
      kind: 'review', summary: 'Okay', workspaceHead: headB,
      findings: [{ severity: 'warning', title: 'Naming', body: 'Optional' }],
    }, headB));
    expect(warning).toMatchObject({ phase: 'SYNTHESIZE', contextRevision: 4 });

    // Fresh run state at REVIEW for the blocking branch.
    run = resetToReview();
    const blocker = await service.accept(persist('REVIEW', 'reviewer', {
      kind: 'review', summary: 'Broken', workspaceHead: headB,
      findings: [{ severity: 'blocker', title: 'Race', body: 'Fix ordering' }],
    }, headB));
    expect(blocker).toMatchObject({ phase: 'BUILD', reviewRetriesUsed: 1, contextRevision: 4 });
    expect(blocker.context.priorFailure).toMatchObject({ source: 'review' });
  });

  it('requires one distinct fresh final Reviewer only after a reused review loop passes', async () => {
    run = toReview();
    run = await service.accept(persist('REVIEW', 'reviewer-loop', {
      kind: 'review', summary: 'Needs work', workspaceHead: headB,
      findings: [{ severity: 'blocker', title: 'Race', body: 'Fix ordering' }],
    }, headB));
    run = apply({ type: 'builder_claimed' }, 'loop-builder-start');
    run = apply({
      type: 'builder_completed', basedOnContextRevision: run.contextRevision, workspaceHead: headB,
    }, 'loop-builder-done');
    run = apply({ type: 'verify_started', basedOnWorkspaceHead: headB }, 'loop-verify-start');
    run = apply({ type: 'verify_passed', basedOnWorkspaceHead: headB }, 'loop-verify-pass');
    run = apply({ type: 'reviewer_claimed', basedOnWorkspaceHead: headB }, 'loop-review-start');
    const requested = await service.accept(persist('REVIEW', 'reviewer-loop', {
      kind: 'review', summary: 'Loop fix is clean', workspaceHead: headB, findings: [],
    }, headB));
    expect(requested).toMatchObject({ phase: 'REVIEW', status: 'QUEUED', reviewRetriesUsed: 1 });
    expect(requested.context.finalReview).toMatchObject({ status: 'pending', workspaceHead: headB });
    run = requested;
    run = runs.applyEvent(run.id, {
      expectedRevision: run.revision, idempotencyKey: 'fresh-review-start', actor: 'nuncio',
      event: { type: 'final_reviewer_claimed', basedOnWorkspaceHead: headB },
      contextPatch: {
        finalReview: { status: 'active', workspaceHead: headB, memberSessionId: 'reviewer-fresh' },
      },
    });
    const passed = await service.accept(persist('REVIEW', 'reviewer-fresh', {
      kind: 'review', summary: 'Independent final pass', workspaceHead: headB, findings: [],
    }, headB));
    expect(passed).toMatchObject({ phase: 'SYNTHESIZE', status: 'QUEUED', reviewRetriesUsed: 1 });
    expect(passed.context.finalReview).toBeNull();
  });

  function persist(phase: CrewRunDto['phase'], member: string, result: CrewMemberResult, workspaceHead = headA) {
    const attempt = results.listByRun(run.id)
      .filter((item) => item.memberSessionId === member && item.phase === phase).length + 1;
    const dto = results.create({
      runId: run.id, memberSessionId: member, phase, attempt, result,
      basedOnContextRevision: run.contextRevision, workspaceHead,
    });
    return { runId: run.id, memberKey: `${member}:primary`, kind: kindOf(result), result: dto, workspaceHead } as never;
  }
  function apply(event: Parameters<CrewRunsRepository['applyEvent']>[1]['event'], key: string,
    workspace?: Parameters<CrewRunsRepository['applyEvent']>[1]['workspace']) {
    return runs.applyEvent(run.id, {
      expectedRevision: run.revision, idempotencyKey: key, actor: 'test', event, workspace,
    });
  }
  function toReview() {
    run = apply({ type: 'plan_accepted' }, 'plan-pass');
    run = apply({ type: 'builder_claimed' }, 'builder-start');
    run = apply({ type: 'builder_completed', basedOnContextRevision: 1, workspaceHead: headB }, 'built');
    run = apply({ type: 'verify_started', basedOnWorkspaceHead: headB }, 'verify-start');
    run = apply({ type: 'verify_passed', basedOnWorkspaceHead: headB }, 'verify-pass');
    return apply({ type: 'reviewer_claimed', basedOnWorkspaceHead: headB }, 'review-start');
  }
  function resetToReview() {
    // Independent aggregate avoids mutating terminal/advanced evidence.
    const task = new CrewTasksRepository(db).create({ objective: 'Other', projectPath: '/source' });
    run = runs.create({ taskId: task.id, profileSnapshot: snapshot, projectPath: '/source' });
    run = apply({ type: 'workspace_prepared', workspaceHead: headA }, 'w2', {
      worktreePath: '/worktree', branch: 'nuncio/run-ship', baseBranch: 'main',
    });
    run = apply({ type: 'plan_started' }, 'ps2');
    return toReview();
  }
});

function kindOf(result: CrewMemberResult): 'plan' | 'build' | 'review' | 'synthesis' {
  if (result.kind === 'builder' || result.kind === 'builder-intent') return 'build';
  return result.kind;
}
