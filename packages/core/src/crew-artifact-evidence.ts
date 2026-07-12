import type { CrewArtifactDto } from './crew-artifact-types';
import type { CrewReviewResult } from './crew-result-types';
import type { CrewRunDetailDto } from './crew-types';

export interface CrewEvidenceArtifactChoice {
  gate: 'verify' | 'review';
  label: 'Verify log' | 'Workspace diff';
  artifact: CrewArtifactDto;
}

export interface CrewBlockingReviewFinding {
  title: string;
  body: string;
}

export function deriveCurrentCrewEvidenceArtifacts(
  run: CrewRunDetailDto,
): CrewEvidenceArtifactChoice[] {
  if (!run.workspaceHead) return [];
  const current = run.artifacts.filter((artifact) =>
    artifact?.metadata?.workspaceHead === run.workspaceHead,
  );
  const verifyGate = [...run.gates].reverse().find((gate) => gate.kind === 'verify');
  const verify = verifyGate?.artifactId
    ? current.find((artifact) =>
        artifact.kind === 'verify-log' && artifact.id === verifyGate.artifactId,
      )
    : latest(current.filter((artifact) => artifact.kind === 'verify-log'));
  const diff = latest(current.filter((artifact) => artifact.kind === 'workspace-diff'));
  return [
    ...(verify ? [{ gate: 'verify' as const, label: 'Verify log' as const, artifact: verify }] : []),
    ...(diff ? [{ gate: 'review' as const, label: 'Workspace diff' as const, artifact: diff }] : []),
  ];
}

export function deriveBlockingReviewFinding(
  run: CrewRunDetailDto,
): CrewBlockingReviewFinding | null {
  const gate = [...run.gates].reverse().find((item) => item.kind === 'review');
  const gateBlocked = gate?.status === 'changes_requested' || gate?.status === 'blocked'
    || gate?.status === 'failed';
  const runBlocked = run.status === 'BLOCKED_USER' && run.blockedReason === 'review_round_cap';
  const staleHead = !!(gate?.workspaceHead && run.workspaceHead
    && gate.workspaceHead !== run.workspaceHead);
  if ((!gateBlocked && !runBlocked) || gate?.status === 'stale' || staleHead) return null;
  const head = gate?.workspaceHead ?? run.workspaceHead;
  const review = latest(run.results.filter((result) =>
    result.result.kind === 'review' && (!head || result.result.workspaceHead === head),
  ));
  if (review?.result.kind !== 'review') return null;
  const blockers = (review.result as CrewReviewResult).findings
    .filter((finding) => finding.severity === 'blocker');
  const finding = blockers.at(-1);
  return finding ? { title: finding.title, body: finding.body } : null;
}

function latest<T extends { createdAt: number }>(items: T[]): T | null {
  let selected: T | null = null;
  for (const item of items) {
    if (!selected || item.createdAt >= selected.createdAt) selected = item;
  }
  return selected;
}
