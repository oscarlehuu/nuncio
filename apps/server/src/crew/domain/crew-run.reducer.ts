import type { CrewRunEventData, CrewRunProjection } from './crew.types';

export class CrewTransitionError extends Error {}

export function createInitialCrewRunProjection(): CrewRunProjection {
  return {
    phase: 'PLAN', status: 'QUEUED', outcome: null, blockedReason: null, revision: 0,
    contextRevision: 0, workspaceHead: null, verifyRetriesUsed: 0, reviewRetriesUsed: 0,
    verifyExtraRounds: 0, reviewExtraRounds: 0,
  };
}

export function assertCrewRunProjection(state: CrewRunProjection): void {
  const terminalTuple = state.phase === 'DONE' && state.status === 'TERMINAL';
  if ((state.phase === 'DONE') !== (state.status === 'TERMINAL')) {
    throw new CrewTransitionError('DONE and TERMINAL must occur together');
  }
  if (terminalTuple !== (state.outcome !== null)) {
    throw new CrewTransitionError('outcome is set if and only if the run is terminal');
  }
  if (state.status === 'BLOCKED_USER' && !state.blockedReason) {
    throw new CrewTransitionError('BLOCKED_USER requires a blocked reason');
  }
  for (const count of [
    state.revision, state.contextRevision, state.verifyRetriesUsed, state.reviewRetriesUsed,
    state.verifyExtraRounds, state.reviewExtraRounds,
  ]) {
    if (!Number.isInteger(count) || count < 0) throw new CrewTransitionError('invalid revision or round count');
  }
}

function requireTuple(state: CrewRunProjection, phase: CrewRunProjection['phase'], status: CrewRunProjection['status']) {
  if (state.phase !== phase || state.status !== status) {
    throw new CrewTransitionError(`${phase}/${status} required, got ${state.phase}/${state.status}`);
  }
}

function requireHead(state: CrewRunProjection, head: string): void {
  if (!head || !state.workspaceHead || head !== state.workspaceHead) {
    throw new CrewTransitionError('workspace evidence is stale');
  }
}

function requireContext(state: CrewRunProjection, revision: number): void {
  if (revision !== state.contextRevision) throw new CrewTransitionError('context evidence is stale');
}

export function reduceCrewRun(
  state: CrewRunProjection,
  event: CrewRunEventData,
  policy: { maxVerifyRetries: number; maxReviewRetries: number },
): CrewRunProjection {
  assertCrewRunProjection(state);
  if (state.status === 'TERMINAL') throw new CrewTransitionError('terminal CrewRuns are immutable');
  if (!Number.isInteger(policy.maxVerifyRetries) || policy.maxVerifyRetries < 0
    || !Number.isInteger(policy.maxReviewRetries) || policy.maxReviewRetries < 0) {
    throw new CrewTransitionError('retry caps must be non-negative integers');
  }

  let next: CrewRunProjection;
  switch (event.type) {
    case 'run_created':
      requireTuple(state, 'PLAN', 'QUEUED');
      if (state.revision !== 0) throw new CrewTransitionError('run_created must be first');
      next = state;
      break;
    case 'workspace_prepared':
      requireTuple(state, 'PLAN', 'QUEUED');
      if (state.workspaceHead || !event.workspaceHead.trim()) {
        throw new CrewTransitionError('workspace can be prepared only once with a full head');
      }
      next = { ...state, workspaceHead: event.workspaceHead };
      break;
    case 'plan_started':
      requireTuple(state, 'PLAN', 'QUEUED'); next = { ...state, status: 'RUNNING' }; break;
    case 'plan_accepted':
      requireTuple(state, 'PLAN', 'RUNNING');
      next = { ...state, phase: 'BUILD', status: 'QUEUED', contextRevision: state.contextRevision + 1 }; break;
    case 'clarification_required':
      requireTuple(state, 'PLAN', 'RUNNING');
      if (!event.reason.trim()) throw new CrewTransitionError('clarification reason is required');
      next = { ...state, status: 'BLOCKED_USER', blockedReason: 'material_clarification',
        contextRevision: state.contextRevision + 1 }; break;
    case 'clarification_resolved':
      requireTuple(state, 'PLAN', 'BLOCKED_USER'); requireContext(state, event.basedOnContextRevision);
      if (state.blockedReason !== 'material_clarification') throw new CrewTransitionError('no clarification is pending');
      next = { ...state, status: 'QUEUED', blockedReason: null, contextRevision: state.contextRevision + 1 }; break;
    case 'builder_claimed':
      requireTuple(state, 'BUILD', 'QUEUED'); next = { ...state, status: 'RUNNING' }; break;
    case 'builder_completed':
      requireTuple(state, 'BUILD', 'RUNNING'); requireContext(state, event.basedOnContextRevision);
      if (!event.workspaceHead.trim()) throw new CrewTransitionError('workspace head is required');
      next = { ...state, phase: 'VERIFY', status: 'QUEUED', workspaceHead: event.workspaceHead,
        contextRevision: state.contextRevision + 1 }; break;
    case 'verify_started':
      requireTuple(state, 'VERIFY', 'QUEUED'); requireHead(state, event.basedOnWorkspaceHead);
      next = { ...state, status: 'RUNNING' }; break;
    case 'verify_passed':
      requireTuple(state, 'VERIFY', 'RUNNING'); requireHead(state, event.basedOnWorkspaceHead);
      next = { ...state, phase: 'REVIEW', status: 'QUEUED', contextRevision: state.contextRevision + 1 }; break;
    case 'verify_failed': {
      requireTuple(state, 'VERIFY', 'RUNNING'); requireHead(state, event.basedOnWorkspaceHead);
      const limit = policy.maxVerifyRetries + state.verifyExtraRounds;
      next = state.verifyRetriesUsed < limit
        ? { ...state, phase: 'BUILD', status: 'QUEUED', verifyRetriesUsed: state.verifyRetriesUsed + 1,
          contextRevision: state.contextRevision + 1 }
        : { ...state, status: 'BLOCKED_USER', blockedReason: 'verify_round_cap',
          contextRevision: state.contextRevision + 1 };
      break;
    }
    case 'reviewer_claimed':
      requireTuple(state, 'REVIEW', 'QUEUED'); requireHead(state, event.basedOnWorkspaceHead);
      next = { ...state, status: 'RUNNING' }; break;
    case 'final_review_requested':
      requireTuple(state, 'REVIEW', 'RUNNING'); requireHead(state, event.basedOnWorkspaceHead);
      next = { ...state, status: 'QUEUED', contextRevision: state.contextRevision + 1 }; break;
    case 'final_reviewer_claimed':
      requireTuple(state, 'REVIEW', 'QUEUED'); requireHead(state, event.basedOnWorkspaceHead);
      next = { ...state, status: 'RUNNING', contextRevision: state.contextRevision + 1 }; break;
    case 'review_passed':
      requireTuple(state, 'REVIEW', 'RUNNING'); requireHead(state, event.basedOnWorkspaceHead);
      next = { ...state, phase: 'SYNTHESIZE', status: 'QUEUED', contextRevision: state.contextRevision + 1 }; break;
    case 'changes_requested': {
      requireTuple(state, 'REVIEW', 'RUNNING'); requireHead(state, event.basedOnWorkspaceHead);
      const limit = policy.maxReviewRetries + state.reviewExtraRounds;
      next = state.reviewRetriesUsed < limit
        ? { ...state, phase: 'BUILD', status: 'QUEUED', reviewRetriesUsed: state.reviewRetriesUsed + 1,
          contextRevision: state.contextRevision + 1 }
        : { ...state, status: 'BLOCKED_USER', blockedReason: 'review_round_cap',
          contextRevision: state.contextRevision + 1 };
      break;
    }
    case 'foreman_claimed':
      requireTuple(state, 'SYNTHESIZE', 'QUEUED'); next = { ...state, status: 'RUNNING' }; break;
    case 'synthesis_completed':
      requireTuple(state, 'SYNTHESIZE', 'RUNNING'); requireContext(state, event.basedOnContextRevision);
      requireHead(state, event.workspaceHead);
      next = { ...state, phase: 'DONE', status: 'TERMINAL', outcome: 'SUCCEEDED',
        contextRevision: state.contextRevision + 1 }; break;
    case 'pause_requested':
      if (state.status === 'PAUSED') throw new CrewTransitionError('run is already paused');
      next = { ...state, status: 'PAUSED' }; break;
    case 'resume_requested':
      if (state.status !== 'PAUSED') throw new CrewTransitionError('run is not paused');
      if (state.blockedReason === 'provider_unavailable') {
        next = { ...state, status: 'BLOCKED_PROVIDER' };
      } else if (state.blockedReason) {
        next = { ...state, status: 'BLOCKED_USER' };
      } else {
        next = { ...state, status: 'QUEUED' };
      }
      break;
    case 'provider_unavailable':
      if (!['QUEUED', 'RUNNING', 'RECOVERING'].includes(state.status)) throw new CrewTransitionError('provider cannot block this state');
      next = { ...state, status: 'BLOCKED_PROVIDER', blockedReason: 'provider_unavailable' }; break;
    case 'provider_restored':
      if (state.status !== 'BLOCKED_PROVIDER') throw new CrewTransitionError('provider is not blocked');
      next = { ...state, status: 'RECOVERING', blockedReason: null }; break;
    case 'recovery_started':
      if (!['QUEUED', 'RUNNING', 'BLOCKED_PROVIDER'].includes(state.status)
        && !(state.status === 'BLOCKED_USER' && state.blockedReason === 'unrecoverable_failure')) {
        throw new CrewTransitionError('run cannot start recovery from this state');
      }
      if (!event.reason.trim()) throw new CrewTransitionError('recovery reason is required');
      next = { ...state, status: 'RECOVERING', blockedReason: null }; break;
    case 'recovery_succeeded':
      if (state.status !== 'RECOVERING') throw new CrewTransitionError('run is not recovering');
      next = { ...state, status: 'QUEUED' }; break;
    case 'recovery_blocked':
      if (state.status !== 'RECOVERING') throw new CrewTransitionError('run is not recovering');
      if (!event.reason.trim()) throw new CrewTransitionError('recovery block reason is required');
      next = { ...state, status: 'BLOCKED_USER', blockedReason: 'unrecoverable_failure' }; break;
    case 'extra_round_approved': {
      const verify = event.gate === 'verify' && state.blockedReason === 'verify_round_cap';
      const review = event.gate === 'review' && state.blockedReason === 'review_round_cap';
      if (state.status !== 'BLOCKED_USER' || (!verify && !review)) throw new CrewTransitionError('round cap is not pending');
      next = { ...state, phase: 'BUILD', status: 'QUEUED', blockedReason: null,
        verifyExtraRounds: state.verifyExtraRounds + (verify ? 1 : 0),
        verifyRetriesUsed: state.verifyRetriesUsed + (verify ? 1 : 0),
        reviewExtraRounds: state.reviewExtraRounds + (review ? 1 : 0),
        reviewRetriesUsed: state.reviewRetriesUsed + (review ? 1 : 0) };
      break;
    }
    case 'cancel_requested':
      next = { ...state, phase: 'DONE', status: 'TERMINAL', outcome: 'CANCELLED', blockedReason: null }; break;
    case 'unrecoverable_failure':
      next = { ...state, phase: 'DONE', status: 'TERMINAL', outcome: 'FAILED', blockedReason: null }; break;
    default:
      throw new CrewTransitionError(`unsupported Crew event: ${(event as { type?: string }).type ?? 'unknown'}`);
  }
  next = { ...next, revision: state.revision + 1 };
  assertCrewRunProjection(next);
  return next;
}
