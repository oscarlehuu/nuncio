import type { CrewContextEnvelope } from './crew-context.types';

export function asString(value: unknown): string { return typeof value === 'string' ? value : ''; }
export function asNullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}
export function asStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}
export function asDecisions(value: unknown): Array<{ id: string; summary: string }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const row = asRecord(item);
    return row && typeof row.id === 'string' && typeof row.summary === 'string'
      ? [{ id: row.id, summary: row.summary }] : [];
  });
}
export function asPriorFailure(value: unknown): CrewContextEnvelope['priorFailure'] {
  const row = asRecord(value);
  if (!row || (row.source !== 'verify' && row.source !== 'review') || typeof row.summary !== 'string') return undefined;
  return { source: row.source, summary: row.summary };
}
export function asPlan(context: Record<string, unknown>): CrewContextEnvelope['plan'] {
  const summary = asString(context.planSummary);
  return summary ? { summary, steps: asStrings(context.planSteps), openQuestions: asStrings(context.openQuestions) }
    : undefined;
}
export function asBuildEvidence(value: unknown): CrewContextEnvelope['latestBuild'] {
  const row = asRecord(value); const summary = asString(row?.summary);
  return row && summary ? { summary, changedFiles: asStrings(row.changedFiles) } : undefined;
}
export function asVerifyEvidence(value: unknown): CrewContextEnvelope['latestVerify'] {
  const row = asRecord(value);
  return row && typeof row.passed === 'boolean' && typeof row.artifactId === 'string'
    ? { passed: row.passed, artifactId: row.artifactId } : undefined;
}
export function asReviewEvidence(value: unknown): CrewContextEnvelope['latestReview'] {
  const row = asRecord(value); const summary = asString(row?.summary);
  if (!row || !summary || !Array.isArray(row.findings)) return undefined;
  return {
    summary,
    findings: row.findings.flatMap((item) => {
      const finding = asRecord(item);
      return finding && typeof finding.severity === 'string'
        && typeof finding.title === 'string' && typeof finding.body === 'string'
        ? [{ severity: finding.severity, title: finding.title, body: finding.body }] : [];
    }),
  };
}
export function asOutcome(value: unknown): CrewContextEnvelope['priorOutcome'] {
  const row = asRecord(value);
  return row && typeof row.summary === 'string' && typeof row.verification === 'string'
    ? { summary: row.summary, verification: row.verification, remainingRisks: asStrings(row.remainingRisks) }
    : undefined;
}
export function asPriorPlan(value: unknown): CrewContextEnvelope['priorPlan'] {
  const row = asRecord(value); const summary = asString(row?.summary);
  return row && summary ? { summary, steps: asStrings(row.steps) } : undefined;
}
export function asRecords(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  const records: Array<Record<string, unknown>> = [];
  for (const item of value) {
    const record = asRecord(item);
    if (record) records.push(record);
  }
  return records;
}
function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
