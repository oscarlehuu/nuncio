import type { CrewRunPhase } from './domain/crew.types';

export type CrewSubmissionKind = 'plan' | 'build' | 'review' | 'synthesis';

export interface CrewToolAuthority {
  runId: string; memberKey: string; contextRevision: number;
  workspaceHead: string; idempotencyKey: string;
}

export function crewSubmissionSchema(kind: CrewSubmissionKind) {
  return {
    type: 'object', additionalProperties: false,
    properties: { ...authorityProperties(), result: resultSchema(kind) },
    required: [...Object.keys(authorityProperties()), 'result'],
  };
}

export function crewArtifactReadSchema() {
  return {
    type: 'object', additionalProperties: false,
    properties: {
      ...authorityProperties(), artifactId: { type: 'string', minLength: 1 },
      offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 65_536 },
    },
    required: [...Object.keys(authorityProperties()), 'artifactId'],
  };
}

export const PHASE_FOR_SUBMISSION: Record<CrewSubmissionKind, CrewRunPhase> = {
  plan: 'PLAN', build: 'BUILD', review: 'REVIEW', synthesis: 'SYNTHESIZE',
};

function authorityProperties() {
  return {
    runId: { type: 'string', minLength: 1 },
    memberKey: { type: 'string', minLength: 1 },
    contextRevision: { type: 'integer', minimum: 0 },
    workspaceHead: { type: 'string', minLength: 1 },
    idempotencyKey: { type: 'string', minLength: 1 },
  };
}

function resultSchema(kind: CrewSubmissionKind): Record<string, unknown> {
  const string = { type: 'string', minLength: 1, maxLength: 16_384 };
  const strings = { type: 'array', maxItems: 200, items: string };
  if (kind === 'plan') return {
    type: 'object', additionalProperties: false,
    properties: { summary: string, steps: strings, openQuestions: strings, materialClarification: string },
    required: ['summary', 'steps', 'openQuestions'],
  };
  if (kind === 'build') return {
    type: 'object', additionalProperties: false,
    properties: { summary: string, changedFiles: strings }, required: ['summary', 'changedFiles'],
  };
  if (kind === 'review') return {
    type: 'object', additionalProperties: false,
    properties: {
      summary: string,
      findings: { type: 'array', maxItems: 200, items: {
        type: 'object', additionalProperties: false,
        properties: {
          severity: { enum: ['blocker', 'warning'] }, title: string, body: string,
          file: string, line: { type: 'integer', minimum: 1 },
        }, required: ['severity', 'title', 'body'],
      } },
    }, required: ['summary', 'findings'],
  };
  return {
    type: 'object', additionalProperties: false,
    properties: { summary: string, verification: string, remainingRisks: strings },
    required: ['summary', 'verification', 'remainingRisks'],
  };
}
