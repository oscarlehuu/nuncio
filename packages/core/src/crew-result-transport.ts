import type {
  CrewBuilderIntentResult,
  CrewBuilderResult,
  CrewMemberResult,
  CrewMemberResultDto,
  CrewMemberResultPhase,
  CrewReviewFinding,
} from './crew-result-types';

type JsonRecord = Record<string, unknown>;
const phases = new Set<CrewMemberResultPhase>(['PLAN', 'BUILD', 'REVIEW', 'SYNTHESIZE']);

function record(value: unknown): value is JsonRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function stringArray(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
    ? [...value]
    : null;
}

function builderBase(value: JsonRecord): Omit<CrewBuilderIntentResult, 'kind'> | null {
  const changedFiles = stringArray(value.changedFiles);
  if (
    typeof value.summary !== 'string' || !changedFiles ||
    typeof value.basedOnWorkspaceHead !== 'string'
  ) return null;
  return {
    summary: value.summary,
    changedFiles,
    basedOnWorkspaceHead: value.basedOnWorkspaceHead,
  };
}

function reviewFinding(value: unknown): CrewReviewFinding | null {
  if (
    !record(value) || !['blocker', 'warning'].includes(String(value.severity)) ||
    typeof value.title !== 'string' || typeof value.body !== 'string' ||
    !(['undefined', 'string'].includes(typeof value.file)) ||
    !(value.line === undefined || (Number.isInteger(value.line) && Number(value.line) > 0))
  ) return null;
  return {
    severity: value.severity as CrewReviewFinding['severity'],
    title: value.title,
    body: value.body,
    ...(typeof value.file === 'string' ? { file: value.file } : {}),
    ...(typeof value.line === 'number' ? { line: value.line } : {}),
  };
}

function resultFrom(value: unknown): CrewMemberResult | null {
  if (!record(value) || typeof value.kind !== 'string') return null;
  if (value.kind === 'plan') {
    const steps = stringArray(value.steps);
    const openQuestions = stringArray(value.openQuestions);
    if (
      typeof value.summary !== 'string' || !steps || !openQuestions ||
      !(['undefined', 'string'].includes(typeof value.materialClarification))
    ) return null;
    return {
      kind: 'plan', summary: value.summary, steps, openQuestions,
      ...(typeof value.materialClarification === 'string'
        ? { materialClarification: value.materialClarification }
        : {}),
    };
  }
  if (value.kind === 'builder-intent' || value.kind === 'builder') {
    const base = builderBase(value);
    if (!base) return null;
    if (value.kind === 'builder-intent') {
      return { kind: 'builder-intent', ...base } satisfies CrewBuilderIntentResult;
    }
    if (typeof value.commitHead !== 'string') return null;
    return { kind: 'builder', ...base, commitHead: value.commitHead } satisfies CrewBuilderResult;
  }
  if (value.kind === 'review') {
    if (
      typeof value.summary !== 'string' || typeof value.workspaceHead !== 'string' ||
      !Array.isArray(value.findings)
    ) return null;
    const findings = value.findings.map(reviewFinding);
    if (findings.some((finding) => !finding)) return null;
    return {
      kind: 'review', summary: value.summary, workspaceHead: value.workspaceHead,
      findings: findings as CrewReviewFinding[],
    };
  }
  if (value.kind === 'synthesis') {
    const remainingRisks = stringArray(value.remainingRisks);
    if (
      typeof value.summary !== 'string' || typeof value.verification !== 'string' ||
      !remainingRisks || typeof value.workspaceHead !== 'string'
    ) return null;
    return {
      kind: 'synthesis', summary: value.summary, verification: value.verification,
      remainingRisks, workspaceHead: value.workspaceHead,
    };
  }
  return null;
}

export function crewMemberResultFrom(value: unknown): CrewMemberResultDto | null {
  if (
    !record(value) || typeof value.id !== 'string' || typeof value.runId !== 'string' ||
    typeof value.memberSessionId !== 'string' ||
    !phases.has(value.phase as CrewMemberResultPhase) ||
    !Number.isInteger(value.attempt) || Number(value.attempt) < 1 ||
    !Number.isInteger(value.basedOnContextRevision) || Number(value.basedOnContextRevision) < 0 ||
    !(typeof value.workspaceHead === 'string' || value.workspaceHead === null) ||
    typeof value.createdAt !== 'number' || !Number.isFinite(value.createdAt)
  ) return null;
  const result = resultFrom(value.result);
  if (!result || !phaseMatches(value.phase as CrewMemberResultPhase, result.kind)) return null;
  return {
    id: value.id,
    runId: value.runId,
    memberSessionId: value.memberSessionId,
    phase: value.phase as CrewMemberResultPhase,
    attempt: value.attempt as number,
    result,
    basedOnContextRevision: value.basedOnContextRevision as number,
    workspaceHead: value.workspaceHead as string | null,
    createdAt: value.createdAt,
  };
}

function phaseMatches(phase: CrewMemberResultPhase, kind: CrewMemberResult['kind']): boolean {
  if (kind === 'plan') return phase === 'PLAN';
  if (kind === 'builder' || kind === 'builder-intent') return phase === 'BUILD';
  if (kind === 'review') return phase === 'REVIEW';
  return phase === 'SYNTHESIZE';
}
