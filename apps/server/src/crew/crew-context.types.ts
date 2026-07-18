import type { CrewRole } from './domain/crew.types';

export interface CrewContextEnvelope {
  kind: 'full'; runId: string; role: CrewRole; contextRevision: number; objective: string; goal: string;
  changeRequest?: string; priorRun?: { id: string; workspaceHead: string | null };
  constraints: string[]; decisions: Array<{ id: string; summary: string }>;
  doneCriteria: string[]; clarifications: string[]; workspace: { fullHead: string | null };
  priorFailure?: { source: 'verify' | 'review'; summary: string };
  uiImpact?: { touched: true; files: string[]; fileCount: number };
  builderEvidence?: { summary: string; changedFiles: string[]; workspaceHead: string };
  plan?: { summary: string; steps: string[]; openQuestions: string[] };
  latestBuild?: { summary: string; changedFiles: string[] };
  latestVerify?: { passed: boolean; artifactId: string };
  latestReview?: { summary: string; findings: Array<{ severity: string; title: string; body: string }> };
  priorOutcome?: { summary: string; verification: string; remainingRisks: string[] };
  priorPlan?: { summary: string; steps: string[] };
  priorGates?: Array<Record<string, unknown>>;
  artifactRefs: Array<{
    id: string; kind: string; byteCount: number; sha256: string; required?: true;
  }>;
}
