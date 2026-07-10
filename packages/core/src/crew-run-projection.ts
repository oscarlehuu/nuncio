import type {
  CrewBlockReason,
  CrewEventDto,
  CrewGateDto,
  CrewGateStatus,
  CrewRunDetailDto,
  CrewRunOutcome,
  CrewRunPhase,
  CrewRunStatus,
} from './crew-api';

export const CREW_PHASES: readonly CrewRunPhase[] = ['PLAN', 'BUILD', 'VERIFY', 'REVIEW', 'SYNTHESIZE', 'DONE'];

export interface CrewRunProjection {
  run: CrewRunDetailDto;
  summary: string;
  steps: Array<{ phase: CrewRunPhase; state: 'complete' | 'current' | 'upcoming' }>;
  actions: Array<'pause' | 'resume' | 'cancel' | 'clarification' | 'extra-verify-round' | 'extra-review-round' | 'successor'>;
}

const phases = new Set(CREW_PHASES);
const statuses = new Set<CrewRunStatus>(['QUEUED', 'RUNNING', 'BLOCKED_USER', 'BLOCKED_PROVIDER', 'PAUSED', 'RECOVERING', 'TERMINAL']);
const outcomes = new Set<Exclude<CrewRunOutcome, null>>(['SUCCEEDED', 'FAILED', 'CANCELLED']);
const reasons = new Set<Exclude<CrewBlockReason, null>>(['material_clarification', 'verify_round_cap', 'review_round_cap', 'provider_unavailable', 'unrecoverable_failure']);
const gateStatuses = new Set<CrewGateStatus>([
  'pending', 'running', 'passed', 'failed', 'changes_requested', 'blocked', 'stale',
]);
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const title = (value: string) => value.toLowerCase().replaceAll('_', ' ').replace(/^\w/, (letter) => letter.toUpperCase());

function upsertGate(run: CrewRunDetailDto, kind: CrewGateDto['kind'], payload: Record<string, unknown>) {
  const status = gateStatuses.has(payload.status as CrewGateStatus) ? payload.status as CrewGateStatus : null;
  if (!status) return;
  const workspaceHead = typeof payload.workspaceHead === 'string' ? payload.workspaceHead : null;
  const gate: CrewGateDto = {
    kind,
    status: workspaceHead && workspaceHead !== run.workspaceHead ? 'stale' : status,
    workspaceHead,
    warnings: Array.isArray(payload.warnings) ? payload.warnings.filter((item): item is string => typeof item === 'string') : [],
    artifactId: typeof payload.artifactId === 'string' ? payload.artifactId : null,
  };
  const index = run.gates.findIndex((item) => item.kind === kind);
  if (index < 0) run.gates.push(gate); else run.gates[index] = gate;
}

function applyEvent(run: CrewRunDetailDto, event: CrewEventDto) {
  if (!record(event.payload)) return;
  const payload = event.payload;
  switch (event.type) {
    case 'phase_changed':
      if (phases.has(payload.phase as CrewRunPhase) && payload.phase !== 'DONE') run.phase = payload.phase as CrewRunPhase;
      return;
    case 'plan_started': run.phase = 'PLAN'; run.status = 'RUNNING'; return;
    case 'plan_accepted': run.phase = 'BUILD'; run.status = 'QUEUED'; return;
    case 'clarification_required':
      run.status = 'BLOCKED_USER'; run.blockedReason = 'material_clarification'; return;
    case 'clarification_resolved':
      run.status = 'QUEUED'; run.blockedReason = null; run.contextRevision = event.contextRevision; return;
    case 'builder_claimed': run.phase = 'BUILD'; run.status = 'RUNNING'; return;
    case 'builder_completed':
      run.phase = 'VERIFY'; run.status = 'QUEUED'; run.contextRevision = event.contextRevision;
      if (typeof payload.workspaceHead === 'string') run.workspaceHead = payload.workspaceHead;
      return;
    case 'verify_started': run.phase = 'VERIFY'; run.status = 'RUNNING'; return;
    case 'verify_passed':
      upsertGate(run, 'verify', { status: 'passed', workspaceHead: payload.basedOnWorkspaceHead ?? event.workspaceHead });
      run.phase = 'REVIEW'; run.status = 'QUEUED'; return;
    case 'verify_failed': {
      upsertGate(run, 'verify', { status: 'failed', workspaceHead: payload.basedOnWorkspaceHead ?? event.workspaceHead });
      const retry = run.verifyRetriesUsed < run.maxVerifyRetries + run.verifyExtraRounds;
      if (retry) { run.phase = 'BUILD'; run.status = 'QUEUED'; run.verifyRetriesUsed += 1; }
      else { run.status = 'BLOCKED_USER'; run.blockedReason = 'verify_round_cap'; }
      return;
    }
    case 'reviewer_claimed': run.phase = 'REVIEW'; run.status = 'RUNNING'; return;
    case 'final_review_requested':
      run.phase = 'REVIEW'; run.status = 'QUEUED'; run.contextRevision = event.contextRevision; return;
    case 'final_reviewer_claimed':
      run.phase = 'REVIEW'; run.status = 'RUNNING'; run.contextRevision = event.contextRevision; return;
    case 'review_passed':
      upsertGate(run, 'review', { status: 'passed', workspaceHead: payload.basedOnWorkspaceHead ?? event.workspaceHead });
      run.phase = 'SYNTHESIZE'; run.status = 'QUEUED'; return;
    case 'changes_requested': {
      upsertGate(run, 'review', { status: 'changes_requested', workspaceHead: payload.basedOnWorkspaceHead ?? event.workspaceHead });
      const retry = run.reviewRetriesUsed < run.maxReviewRetries + run.reviewExtraRounds;
      if (retry) { run.phase = 'BUILD'; run.status = 'QUEUED'; run.reviewRetriesUsed += 1; }
      else { run.status = 'BLOCKED_USER'; run.blockedReason = 'review_round_cap'; }
      return;
    }
    case 'foreman_claimed': run.phase = 'SYNTHESIZE'; run.status = 'RUNNING'; return;
    case 'synthesis_completed':
      run.phase = 'DONE'; run.status = 'TERMINAL'; run.outcome = 'SUCCEEDED'; return;
    case 'pause_requested': run.status = 'PAUSED'; return;
    case 'resume_requested': run.status = run.blockedReason === 'provider_unavailable' ? 'BLOCKED_PROVIDER' : run.blockedReason ? 'BLOCKED_USER' : 'QUEUED'; return;
    case 'provider_unavailable': run.status = 'BLOCKED_PROVIDER'; run.blockedReason = 'provider_unavailable'; return;
    case 'provider_restored': run.status = 'RECOVERING'; run.blockedReason = null; return;
    case 'recovery_succeeded': run.status = 'QUEUED'; return;
    case 'extra_round_approved': {
      const verify = payload.gate === 'verify';
      run.phase = 'BUILD'; run.status = 'QUEUED'; run.blockedReason = null;
      if (verify) { run.verifyExtraRounds += 1; run.verifyRetriesUsed += 1; }
      else { run.reviewExtraRounds += 1; run.reviewRetriesUsed += 1; }
      return;
    }
    case 'cancel_requested':
      run.phase = 'DONE'; run.status = 'TERMINAL'; run.outcome = 'CANCELLED'; run.blockedReason = null; return;
    case 'unrecoverable_failure':
      run.phase = 'DONE'; run.status = 'TERMINAL'; run.outcome = 'FAILED'; run.blockedReason = null; return;
    case 'status_changed':
      if (statuses.has(payload.status as CrewRunStatus) && payload.status !== 'TERMINAL') run.status = payload.status as CrewRunStatus;
      if (reasons.has(payload.reason as Exclude<CrewBlockReason, null>)) run.blockedReason = payload.reason as CrewBlockReason;
      return;
    case 'recovery_started': run.status = 'RECOVERING'; return;
    case 'provider_blocked':
      run.status = 'BLOCKED_PROVIDER';
      run.blockedReason = reasons.has(payload.reason as Exclude<CrewBlockReason, null>) ? payload.reason as CrewBlockReason : 'provider_unavailable';
      return;
    case 'run_paused': run.status = 'PAUSED'; return;
    case 'run_resumed': run.status = 'QUEUED'; run.blockedReason = null; return;
    case 'workspace_advanced': {
      if (typeof payload.workspaceHead !== 'string' || !payload.workspaceHead) return;
      run.workspaceHead = payload.workspaceHead;
      run.gates = run.gates.map((gate) => gate.workspaceHead && gate.workspaceHead !== run.workspaceHead ? { ...gate, status: 'stale' } : gate);
      return;
    }
    case 'verify_completed': upsertGate(run, 'verify', payload); return;
    case 'review_completed': upsertGate(run, 'review', payload); return;
    case 'run_completed':
      if (!outcomes.has(payload.outcome as Exclude<CrewRunOutcome, null>)) return;
      run.phase = 'DONE'; run.status = 'TERMINAL'; run.outcome = payload.outcome as CrewRunOutcome; run.blockedReason = null;
      return;
    default: return;
  }
}

function actionsFor(run: CrewRunDetailDto): CrewRunProjection['actions'] {
  if (run.status === 'TERMINAL') return ['successor'];
  if (run.status === 'BLOCKED_USER') {
    if (run.blockedReason === 'material_clarification') return ['clarification', 'cancel'];
    if (run.blockedReason === 'verify_round_cap') return ['extra-verify-round', 'cancel'];
    if (run.blockedReason === 'review_round_cap') return ['extra-review-round', 'cancel'];
    return ['cancel'];
  }
  if (run.status === 'PAUSED' || run.status === 'BLOCKED_PROVIDER') return ['resume', 'cancel'];
  if (run.status === 'QUEUED' || run.status === 'RUNNING') return ['pause', 'cancel'];
  return ['cancel'];
}

export function projectCrewRun(base: CrewRunDetailDto, events: CrewEventDto[] = []): CrewRunProjection {
  const run: CrewRunDetailDto = { ...base, members: [...base.members], gates: base.gates.map((gate) => ({ ...gate, warnings: [...gate.warnings] })), results: [...base.results], artifacts: [...base.artifacts] };
  run.gates = run.gates.map((gate) => gate.workspaceHead && run.workspaceHead && gate.workspaceHead !== run.workspaceHead ? { ...gate, status: 'stale' } : gate);
  const seen = new Set<number>();
  for (const event of [...events].sort((a, b) => a.seq - b.seq)) {
    if (!Number.isInteger(event.seq) || event.seq <= run.revision || seen.has(event.seq)) continue;
    seen.add(event.seq);
    applyEvent(run, event);
    run.revision = event.seq;
  }
  const current = CREW_PHASES.indexOf(run.phase);
  const steps = CREW_PHASES.map((phase, index) => ({ phase, state: index < current ? 'complete' as const : index === current ? 'current' as const : 'upcoming' as const }));
  const round = run.phase === 'VERIFY' ? ` · round ${run.verifyRetriesUsed + 1}/${run.maxVerifyRetries + run.verifyExtraRounds + 1}` : run.phase === 'REVIEW' ? ` · round ${run.reviewRetriesUsed + 1}/${run.maxReviewRetries + run.reviewExtraRounds + 1}` : '';
  return { run, steps, actions: actionsFor(run), summary: `${title(run.phase)} · ${title(run.status)}${round}` };
}
