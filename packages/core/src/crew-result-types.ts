export type CrewMemberResultPhase = 'PLAN' | 'BUILD' | 'REVIEW' | 'SYNTHESIZE';

export interface CrewPlanResult {
  kind: 'plan';
  summary: string;
  steps: string[];
  openQuestions: string[];
  materialClarification?: string;
}

export interface CrewBuilderIntentResult {
  kind: 'builder-intent';
  summary: string;
  changedFiles: string[];
  basedOnWorkspaceHead: string;
}

export interface CrewBuilderResult extends Omit<CrewBuilderIntentResult, 'kind'> {
  kind: 'builder';
  commitHead: string;
}

export interface CrewReviewFinding {
  severity: 'blocker' | 'warning';
  title: string;
  body: string;
  file?: string;
  line?: number;
}

export interface CrewReviewResult {
  kind: 'review';
  summary: string;
  findings: CrewReviewFinding[];
  workspaceHead: string;
}

export interface CrewSynthesisResult {
  kind: 'synthesis';
  summary: string;
  verification: string;
  remainingRisks: string[];
  workspaceHead: string;
}

export type CrewMemberResult =
  | CrewPlanResult
  | CrewBuilderIntentResult
  | CrewBuilderResult
  | CrewReviewResult
  | CrewSynthesisResult;

export interface CrewMemberResultDto {
  id: string;
  runId: string;
  memberSessionId: string;
  phase: CrewMemberResultPhase;
  attempt: number;
  result: CrewMemberResult;
  basedOnContextRevision: number;
  workspaceHead: string | null;
  createdAt: number;
}
