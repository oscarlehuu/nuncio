import { apiFetch } from './http';
import {
  CrewApiError,
  type CrewProfileDto,
  type CrewRunDto,
  type CrewRunPhase,
  type CrewRunSummaryDto,
  type CrewRunStatus,
  type CrewTaskDto,
} from './crew-types';

export type JsonRecord = Record<string, unknown>;
const phases = new Set<CrewRunPhase>(['PLAN', 'BUILD', 'VERIFY', 'REVIEW', 'SYNTHESIZE', 'DONE']);
const statuses = new Set<CrewRunStatus>([
  'QUEUED', 'RUNNING', 'BLOCKED_USER', 'BLOCKED_PROVIDER', 'PAUSED', 'RECOVERING', 'TERMINAL',
]);
export const isRecord = (value: unknown): value is JsonRecord =>
  !!value && typeof value === 'object' && !Array.isArray(value);
export const malformed = (name: string): never => {
  throw new Error(`Malformed Crew ${name} response`);
};
export const idPath = (id: string) => encodeURIComponent(id);
export const jsonInit = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

export function profileFrom(value: unknown): CrewProfileDto {
  if (
    !isRecord(value) || typeof value.id !== 'string' || typeof value.name !== 'string' ||
    typeof value.revision !== 'number' || value.presetId !== 'quality' ||
    !isRecord(value.definition) || typeof value.createdAt !== 'number' ||
    typeof value.updatedAt !== 'number'
  ) malformed('profile');
  return value as unknown as CrewProfileDto;
}

export function taskFrom(value: unknown): CrewTaskDto {
  if (
    !isRecord(value) || typeof value.id !== 'string' || typeof value.objective !== 'string' ||
    typeof value.projectPath !== 'string' || typeof value.createdAt !== 'number' ||
    typeof value.updatedAt !== 'number'
  ) malformed('task');
  return value as unknown as CrewTaskDto;
}

export function runFrom(value: unknown): CrewRunDto {
  if (
    !isRecord(value) || typeof value.id !== 'string' || typeof value.taskId !== 'string' ||
    !phases.has(value.phase as CrewRunPhase) || !statuses.has(value.status as CrewRunStatus) ||
    typeof value.revision !== 'number' || typeof value.contextRevision !== 'number' ||
    typeof value.projectPath !== 'string' || !isRecord(value.profileSnapshot) ||
    !(typeof value.workspaceHead === 'string' || value.workspaceHead === null)
  ) malformed('run');
  const run = value as unknown as CrewRunDto;
  const policy = isRecord(run.profileSnapshot) && isRecord(run.profileSnapshot.policy)
    ? run.profileSnapshot.policy
    : null;
  return {
    ...run,
    context: isRecord(run.context) ? run.context : {},
    maxVerifyRetries: typeof run.maxVerifyRetries === 'number'
      ? run.maxVerifyRetries : Number(policy?.maxVerifyRetries ?? 2),
    maxReviewRetries: typeof run.maxReviewRetries === 'number'
      ? run.maxReviewRetries : Number(policy?.maxReviewRetries ?? 2),
  };
}

export function runSummaryFrom(value: unknown): CrewRunSummaryDto {
  const summary = isRecord(value) ? value : malformed('run summary');
  if (
    typeof summary.id !== 'string' || typeof summary.taskId !== 'string' ||
    typeof summary.objective !== 'string' || !phases.has(summary.phase as CrewRunPhase) ||
    !statuses.has(summary.status as CrewRunStatus) || typeof summary.revision !== 'number' ||
    !(typeof summary.workspaceHead === 'string' || summary.workspaceHead === null) ||
    typeof summary.createdAt !== 'number' || typeof summary.updatedAt !== 'number'
  ) malformed('run summary');
  if (summary.outcome !== null && !['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(String(summary.outcome))) {
    malformed('run summary');
  }
  return summary as unknown as CrewRunSummaryDto;
}

export async function request(path: string, init?: RequestInit, base = ''): Promise<JsonRecord> {
  const response = await apiFetch(`${base}${path}`, init);
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new CrewApiError('Malformed Crew response', response.status);
  }
  if (!response.ok) {
    const raw = isRecord(body) ? body : {};
    const currentValue = isRecord(raw.current) && 'run' in raw.current
      ? raw.current.run : raw.current;
    let current: CrewRunDto | null = null;
    try {
      if (currentValue) current = runFrom(currentValue);
    } catch {
      current = null;
    }
    throw new CrewApiError(
      typeof raw.message === 'string' ? raw.message : 'Crew request failed',
      response.status,
      current,
    );
  }
  if (!isRecord(body)) malformed('API');
  return body as JsonRecord;
}
