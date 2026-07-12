import type {
  CrewBuilderIntentResult, CrewMemberResult, CrewPlanResult, CrewReviewFinding,
  CrewReviewResult, CrewSynthesisResult,
} from './domain/crew-results';
import type { CrewSubmissionKind, CrewToolAuthority } from './crew-runtime-tool.schemas';
import { redactHighConfidenceSecrets } from '../git/git-sensitive-checkpoint-paths';

export function assertCrewToolAuthority(input: Record<string, unknown>, expected: CrewToolAuthority): void {
  for (const [field, value] of Object.entries(expected)) {
    if (input[field] !== value) throw new Error(`Crew tool scope mismatch: ${field}`);
  }
}

export function parseCrewSubmission(
  kind: CrewSubmissionKind,
  value: unknown,
  basedOnWorkspaceHead: string,
  workspaceHead = basedOnWorkspaceHead,
): CrewMemberResult {
  const serialized = JSON.stringify(value);
  if (serialized && Buffer.byteLength(serialized, 'utf8') > 262_144) {
    throw new Error('structured Crew result must be at most 262144 UTF-8 bytes');
  }
  const input = record(value, 'result');
  if (kind === 'plan') {
    assertKeys(input, ['summary', 'steps', 'openQuestions', 'materialClarification']);
    const result: CrewPlanResult = {
      kind, summary: prose(input.summary, 'summary'), steps: proseStrings(input.steps, 'steps'),
      openQuestions: proseStrings(input.openQuestions, 'openQuestions'),
      ...(input.materialClarification === undefined ? {} : {
        materialClarification: prose(input.materialClarification, 'materialClarification'),
      }),
    };
    return result;
  }
  if (kind === 'build') {
    assertKeys(input, ['summary', 'changedFiles']);
    return {
      kind: 'builder-intent', summary: prose(input.summary, 'summary'),
      changedFiles: identifiers(input.changedFiles, 'changedFiles'), basedOnWorkspaceHead,
    } satisfies CrewBuilderIntentResult;
  }
  if (kind === 'review') {
    assertKeys(input, ['summary', 'findings']);
    if (!Array.isArray(input.findings) || input.findings.length > 200) throw new Error('findings must be an array');
    return {
      kind, summary: prose(input.summary, 'summary'),
      findings: input.findings.map(parseFinding), workspaceHead,
    } satisfies CrewReviewResult;
  }
  assertKeys(input, ['summary', 'verification', 'remainingRisks']);
  return {
    kind, summary: prose(input.summary, 'summary'), verification: prose(input.verification, 'verification'),
    remainingRisks: proseStrings(input.remainingRisks, 'remainingRisks'), workspaceHead,
  } satisfies CrewSynthesisResult;
}

function parseFinding(value: unknown): CrewReviewFinding {
  const input = record(value, 'finding');
  assertKeys(input, ['severity', 'title', 'body', 'file', 'line']);
  if (input.severity !== 'blocker' && input.severity !== 'warning') throw new Error('invalid finding severity');
  if (input.line !== undefined && (!Number.isInteger(input.line) || (input.line as number) < 1)) {
    throw new Error('finding line must be positive');
  }
  return {
    severity: input.severity,
    title: prose(input.title, 'finding.title'), body: prose(input.body, 'finding.body'),
    ...(input.file === undefined ? {} : { file: identifier(input.file, 'finding.file') }),
    ...(input.line === undefined ? {} : { line: input.line as number }),
  };
}
function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 16_384) throw new Error(`${field} is invalid`);
  return value.trim();
}
function prose(value: unknown, field: string): string {
  return redactHighConfidenceSecrets(text(value, field));
}
function proseStrings(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length > 200) throw new Error(`${field} must be an array`);
  return value.map((item) => prose(item, field));
}
function identifier(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 16_384) {
    throw new Error(`${field} is invalid`);
  }
  return value;
}
function identifiers(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length > 200) throw new Error(`${field} must be an array`);
  return value.map((item) => identifier(item, field));
}
function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${field} must be an object`);
  return value as Record<string, unknown>;
}
function assertKeys(value: Record<string, unknown>, allowed: string[]): void {
  const extras = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extras.length) throw new Error(`unexpected result fields: ${extras.join(', ')}`);
}
