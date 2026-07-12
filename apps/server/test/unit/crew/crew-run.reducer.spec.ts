import {
  assertCrewRunProjection,
  createInitialCrewRunProjection,
  reduceCrewRun,
  CrewTransitionError,
} from '../../../src/crew/domain/crew-run.reducer';
import type { CrewRunEventData, CrewRunProjection } from '../../../src/crew/domain/crew.types';

const policy = { maxVerifyRetries: 2, maxReviewRetries: 2 };

function apply(state: CrewRunProjection, ...events: CrewRunEventData[]) {
  return events.reduce((current, event) => reduceCrewRun(current, event, policy), state);
}

describe('CrewRun reducer', () => {
  it('follows the fixed Quality happy path and only sets outcome at terminal', () => {
    const initial = createInitialCrewRunProjection();
    const final = apply(
      initial,
      { type: 'run_created' },
      { type: 'plan_started' },
      { type: 'plan_accepted' },
      { type: 'builder_claimed' },
      { type: 'builder_completed', basedOnContextRevision: 1, workspaceHead: 'head-1' },
      { type: 'verify_started', basedOnWorkspaceHead: 'head-1' },
      { type: 'verify_passed', basedOnWorkspaceHead: 'head-1' },
      { type: 'reviewer_claimed', basedOnWorkspaceHead: 'head-1' },
      { type: 'review_passed', basedOnWorkspaceHead: 'head-1' },
      { type: 'foreman_claimed' },
      { type: 'synthesis_completed', basedOnContextRevision: 4, workspaceHead: 'head-1' },
    );

    expect(initial).toMatchObject({ phase: 'PLAN', status: 'QUEUED', outcome: null, revision: 0 });
    expect(final).toMatchObject({
      phase: 'DONE',
      status: 'TERMINAL',
      outcome: 'SUCCEEDED',
      contextRevision: 5,
      revision: 11,
    });
  });

  it('blocks only for a material PLAN clarification and resumes with new context', () => {
    let state = apply(
      createInitialCrewRunProjection(),
      { type: 'run_created' },
      { type: 'plan_started' },
      { type: 'clarification_required', reason: 'Choose the public API shape' },
    );
    expect(state).toMatchObject({
      phase: 'PLAN', status: 'BLOCKED_USER', blockedReason: 'material_clarification',
    });

    state = reduceCrewRun(
      state,
      { type: 'clarification_resolved', basedOnContextRevision: 1 },
      policy,
    );
    expect(state).toMatchObject({ phase: 'PLAN', status: 'QUEUED', contextRevision: 2 });
  });

  it('treats initial verify as free and blocks only after two verify retries', () => {
    let state: CrewRunProjection = {
      ...createInitialCrewRunProjection(),
      phase: 'VERIFY', status: 'RUNNING', workspaceHead: 'head-1', revision: 5,
    };
    state = reduceCrewRun(state, { type: 'verify_failed', basedOnWorkspaceHead: 'head-1' }, policy);
    expect(state).toMatchObject({ phase: 'BUILD', verifyRetriesUsed: 1 });
    state = { ...state, phase: 'VERIFY', status: 'RUNNING', revision: 8 };
    state = reduceCrewRun(state, { type: 'verify_failed', basedOnWorkspaceHead: 'head-1' }, policy);
    expect(state).toMatchObject({ phase: 'BUILD', verifyRetriesUsed: 2 });
    state = { ...state, phase: 'VERIFY', status: 'RUNNING', revision: 11 };
    state = reduceCrewRun(state, { type: 'verify_failed', basedOnWorkspaceHead: 'head-1' }, policy);
    expect(state).toMatchObject({
      phase: 'VERIFY', status: 'BLOCKED_USER', blockedReason: 'verify_round_cap', verifyRetriesUsed: 2,
    });
  });

  it('keeps review retry accounting separate from verify retries', () => {
    const state: CrewRunProjection = {
      ...createInitialCrewRunProjection(),
      phase: 'REVIEW', status: 'RUNNING', workspaceHead: 'head-1', revision: 9,
      verifyRetriesUsed: 2,
    };
    const next = reduceCrewRun(state, { type: 'changes_requested', basedOnWorkspaceHead: 'head-1' }, policy);
    expect(next).toMatchObject({ phase: 'BUILD', verifyRetriesUsed: 2, reviewRetriesUsed: 1 });
  });

  it('advances context revision for every durable shared feedback mutation', () => {
    let state: CrewRunProjection = {
      ...createInitialCrewRunProjection(), phase: 'VERIFY', status: 'RUNNING',
      workspaceHead: 'head-1', revision: 5, contextRevision: 3,
    };
    state = reduceCrewRun(state, { type: 'verify_failed', basedOnWorkspaceHead: 'head-1' }, policy);
    expect(state.contextRevision).toBe(4);
    state = { ...state, phase: 'REVIEW', status: 'RUNNING', revision: 8 };
    state = reduceCrewRun(state, { type: 'changes_requested', basedOnWorkspaceHead: 'head-1' }, policy);
    expect(state.contextRevision).toBe(5);
  });

  it('preserves phase through pause and provider recovery', () => {
    let state: CrewRunProjection = {
      ...createInitialCrewRunProjection(), phase: 'BUILD', status: 'RUNNING', revision: 4,
    };
    state = reduceCrewRun(state, { type: 'pause_requested' }, policy);
    expect(state).toMatchObject({ phase: 'BUILD', status: 'PAUSED' });
    state = reduceCrewRun(state, { type: 'resume_requested' }, policy);
    state = reduceCrewRun(state, { type: 'provider_unavailable', reason: 'auth expired' }, policy);
    state = reduceCrewRun(state, { type: 'provider_restored' }, policy);
    state = reduceCrewRun(state, { type: 'recovery_succeeded' }, policy);
    expect(state).toMatchObject({ phase: 'BUILD', status: 'QUEUED' });
  });

  it('moves an interrupted active phase directly through RECOVERING without losing phase', () => {
    let state: CrewRunProjection = {
      ...createInitialCrewRunProjection(), phase: 'VERIFY', status: 'RUNNING',
      workspaceHead: 'head-1', revision: 7,
    };
    state = reduceCrewRun(state, { type: 'recovery_started', reason: 'daemon_restart' }, policy);
    expect(state).toMatchObject({ phase: 'VERIFY', status: 'RECOVERING', blockedReason: null });
    state = reduceCrewRun(state, { type: 'recovery_succeeded' }, policy);
    expect(state).toMatchObject({ phase: 'VERIFY', status: 'QUEUED', workspaceHead: 'head-1' });
  });

  it('blocks an irreconcilable workspace without terminating or changing phase', () => {
    let state: CrewRunProjection = {
      ...createInitialCrewRunProjection(), phase: 'BUILD', status: 'RUNNING',
      workspaceHead: 'head-1', revision: 4,
    };
    state = reduceCrewRun(state, { type: 'recovery_started', reason: 'daemon_restart' }, policy);
    state = reduceCrewRun(state, { type: 'recovery_blocked', reason: 'workspace moved' }, policy);
    expect(state).toMatchObject({
      phase: 'BUILD', status: 'BLOCKED_USER', blockedReason: 'unrecoverable_failure', outcome: null,
    });
  });

  it('cannot bypass a user blocker by pausing and resuming', () => {
    let state: CrewRunProjection = {
      ...createInitialCrewRunProjection(), phase: 'VERIFY', status: 'BLOCKED_USER',
      blockedReason: 'verify_round_cap', workspaceHead: 'head-1', revision: 9,
    };
    state = reduceCrewRun(state, { type: 'pause_requested' }, policy);
    expect(state).toMatchObject({ status: 'PAUSED', blockedReason: 'verify_round_cap' });
    state = reduceCrewRun(state, { type: 'resume_requested' }, policy);
    expect(state).toMatchObject({ status: 'BLOCKED_USER', blockedReason: 'verify_round_cap' });
  });

  it('rejects stale context/head evidence and terminal mutation', () => {
    const build: CrewRunProjection = {
      ...createInitialCrewRunProjection(), phase: 'BUILD', status: 'RUNNING', contextRevision: 3,
    };
    expect(() => reduceCrewRun(build, {
      type: 'builder_completed', basedOnContextRevision: 2, workspaceHead: 'head-1',
    }, policy)).toThrow(CrewTransitionError);

    const verify = { ...build, phase: 'VERIFY' as const, workspaceHead: 'head-2' };
    expect(() => reduceCrewRun(verify, {
      type: 'verify_passed', basedOnWorkspaceHead: 'head-1',
    }, policy)).toThrow(CrewTransitionError);

    const terminal: CrewRunProjection = {
      ...createInitialCrewRunProjection(), phase: 'DONE', status: 'TERMINAL', outcome: 'FAILED',
    };
    expect(() => reduceCrewRun(terminal, { type: 'cancel_requested' }, policy)).toThrow(CrewTransitionError);
  });

  it('rejects illegal tuples and non-MVP publish/approval events', () => {
    expect(() => assertCrewRunProjection({
      ...createInitialCrewRunProjection(), phase: 'DONE', status: 'RUNNING',
    })).toThrow(CrewTransitionError);
    expect(() => reduceCrewRun(
      createInitialCrewRunProjection(),
      { type: 'publish_succeeded' } as never,
      policy,
    )).toThrow(CrewTransitionError);
  });
});
