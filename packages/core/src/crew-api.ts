import {
  idPath,
  isRecord,
  jsonInit,
  malformed,
  profileFrom,
  request,
  runFrom,
  runSummaryFrom,
  taskFrom,
  type JsonRecord,
} from './crew-transport';
import { crewMemberResultFrom } from './crew-result-transport';
import { crewArtifactFrom, crewArtifactRangeFrom } from './crew-artifact-transport';
import type { CrewArtifactRangeDto } from './crew-artifact-types';
import type {
  CreateCrewSuccessorInput,
  CreateCrewTaskInput,
  CrewEventDto,
  CrewGateDto,
  CrewMemberDto,
  CrewProfileDto,
  CrewProfileInput,
  CrewRunCommand,
  CrewRunCommandInput,
  CrewRunDetailDto,
  CrewRunDto,
  CrewRunSummaryDto,
  CrewRunStatus,
  CrewTaskDto,
  ResolvedCrewProfileDto,
} from './crew-types';

export * from './crew-types';
export * from './crew-outcome-evidence';
export * from './crew-artifact-evidence';

export async function fetchCrewArtifactRange(
  runId: string,
  artifactId: string,
  options: { offset?: number; limit?: number } = {},
): Promise<CrewArtifactRangeDto> {
  const offset = options.offset ?? 0;
  const limit = options.limit ?? 16_384;
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('offset must be a non-negative integer');
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 65_536) {
    throw new Error('limit must be from 1 to 65536');
  }
  const body = await request(
    `/api/crew-runs/${idPath(runId)}/artifacts/${idPath(artifactId)}?offset=${offset}&limit=${limit}`,
  );
  const range = crewArtifactRangeFrom(body.range, { artifactId, offset, limit });
  return range ?? malformed('artifact range');
}

export async function fetchCrewProfiles(): Promise<CrewProfileDto[]> {
  const profiles = (await request('/api/crew/profiles')).profiles;
  if (!Array.isArray(profiles)) malformed('profiles');
  return (profiles as unknown[]).map(profileFrom);
}
export async function fetchCrewProfile(id: string): Promise<CrewProfileDto> {
  return profileFrom((await request(`/api/crew/profiles/${idPath(id)}`)).profile);
}
export async function createCrewProfile(input: CrewProfileInput): Promise<CrewProfileDto> {
  return profileFrom((await request('/api/crew/profiles', jsonInit('POST', { ...input, presetId: 'quality' }))).profile);
}
export async function updateCrewProfile(id: string, input: CrewProfileInput): Promise<CrewProfileDto> {
  return profileFrom((await request(`/api/crew/profiles/${idPath(id)}`, jsonInit('PATCH', input))).profile);
}
export async function deleteCrewProfile(id: string): Promise<void> {
  const body = await request(`/api/crew/profiles/${idPath(id)}`, { method: 'DELETE' });
  if (body.ok !== true) malformed('delete profile');
}
export async function resolveCrewProfile(
  id: string,
  projectPath?: string,
  signal?: AbortSignal,
): Promise<ResolvedCrewProfileDto> {
  const body = projectPath ? { projectPath } : {};
  const init = { ...jsonInit('POST', body), signal };
  const resolution = (await request(`/api/crew/profiles/${idPath(id)}/resolve`, init)).resolution;
  if (
    !isRecord(resolution) || !['ready', 'needs_setup'].includes(String(resolution.state)) ||
    !isRecord(resolution.snapshot) || !Array.isArray(resolution.issues)
  ) malformed('profile resolution');
  return resolution as unknown as ResolvedCrewProfileDto;
}
export async function createCrewTask(
  input: CreateCrewTaskInput,
): Promise<{ task: CrewTaskDto; run: CrewRunDto }> {
  const body = await request('/api/crew/tasks', jsonInit('POST', input));
  return { task: taskFrom(body.task), run: runFrom(body.run) };
}
export async function fetchCrewTask(
  id: string,
): Promise<{ task: CrewTaskDto; runs: CrewRunDto[] }> {
  const body = await request(`/api/crew/tasks/${idPath(id)}`);
  const runs = body.runs;
  if (!Array.isArray(runs)) malformed('task runs');
  return { task: taskFrom(body.task), runs: (runs as unknown[]).map(runFrom) };
}
export async function createCrewSuccessorRun(
  taskId: string,
  input: CreateCrewSuccessorInput,
): Promise<{ task: CrewTaskDto; run: CrewRunDto }> {
  const body = await request(`/api/crew/tasks/${idPath(taskId)}/runs`, jsonInit('POST', input));
  return { task: taskFrom(body.task), run: runFrom(body.run) };
}
export async function fetchCrewRuns(
  query: { status?: CrewRunStatus; projectPath?: string; limit?: number; offset?: number } = {},
): Promise<CrewRunSummaryDto[]> {
  if (query.limit !== undefined && (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 100)) {
    throw new Error('limit must be from 1 to 100');
  }
  if (query.offset !== undefined && (!Number.isSafeInteger(query.offset) || query.offset < 0)) {
    throw new Error('offset must be a non-negative integer');
  }
  const params = new URLSearchParams();
  if (query.status) params.set('status', query.status);
  if (query.projectPath) params.set('projectPath', query.projectPath);
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  if (query.offset !== undefined) params.set('offset', String(query.offset));
  const runs = (await request(`/api/crew-runs${params.size ? `?${params}` : ''}`)).runs;
  if (!Array.isArray(runs)) malformed('runs');
  return (runs as unknown[]).map(runSummaryFrom);
}
export async function fetchCrewRun(id: string): Promise<CrewRunDetailDto> {
  const body = await request(`/api/crew-runs/${idPath(id)}`);
  const run = runFrom(body.run);
  const { members, results, artifacts } = body;
  if (
    !Array.isArray(members) || !Array.isArray(results) || !Array.isArray(artifacts) ||
    !isRecord(body.gates)
  ) malformed('run detail');
  const counters = body.gates as JsonRecord;
  const verify = isRecord(counters.verify) ? counters.verify : {};
  const review = isRecord(counters.review) ? counters.review : {};
  const evidence = Array.isArray(counters.items) ? counters.items : [];
  return {
    ...run,
    maxVerifyRetries: Number(verify.retryLimit ?? run.maxVerifyRetries),
    maxReviewRetries: Number(review.retryLimit ?? run.maxReviewRetries),
    members: (members as unknown[]).map((member) => memberFrom(member, run)),
    gates: evidence as CrewGateDto[],
    results: (results as unknown[])
      .map(crewMemberResultFrom)
      .filter((result): result is NonNullable<typeof result> =>
        result !== null && result.runId === run.id,
      ),
    artifacts: (artifacts as unknown[])
      .map(crewArtifactFrom)
      .filter((artifact): artifact is NonNullable<typeof artifact> =>
        artifact !== null && artifact.runId === run.id,
      ),
  };
}

function memberFrom(value: unknown, run: CrewRunDto): CrewMemberDto {
  if (!isRecord(value)) malformed('member');
  const member = value as JsonRecord;
  if (typeof member.id !== 'string' || typeof member.provider !== 'string' ||
      typeof member.model !== 'string') malformed('member');
  const key = typeof member.memberKey === 'string' ? member.memberKey : member.role;
  const role = ['foreman', 'builder', 'reviewer', 'tester']
    .find((candidate) => typeof key === 'string' && key.startsWith(candidate));
  if (!role) malformed('member role');
  const binding = role === 'tester' ? null : run.profileSnapshot.bindings[role as 'foreman' | 'builder' | 'reviewer'];
  return {
    id: member.id as string,
    role: role as CrewMemberDto['role'],
    label: typeof member.label === 'string' ? member.label : role === 'tester' ? 'Nuncio Tester' : binding?.label || member.model as string,
    provider: member.provider as string,
    model: member.model as string,
    sessionId: typeof member.sessionId === 'string' ? member.sessionId : null,
    status: typeof member.status === 'string' ? member.status : typeof member.lifecycle === 'string' ? member.lifecycle : 'unknown',
  };
}
export async function fetchCrewRunEvents(
  id: string,
  since = 0,
  limit = 100,
): Promise<{ events: CrewEventDto[]; nextSince: number }> {
  const body = await request(`/api/crew-runs/${idPath(id)}/events?since=${since}&limit=${limit}`);
  const { events, nextSince } = body;
  if (!Array.isArray(events) || typeof nextSince !== 'number') malformed('events');
  return { events: events as CrewEventDto[], nextSince: nextSince as number };
}
export async function commandCrewRun(
  id: string,
  command: CrewRunCommand,
  input: CrewRunCommandInput,
): Promise<CrewRunDto> {
  const allowed: CrewRunCommand[] = ['pause', 'resume', 'cancel', 'clarification', 'extra-round'];
  if (!allowed.includes(command)) throw new Error('Unsupported Crew command');
  if (!Number.isInteger(input.expectedRevision)) throw new Error('expectedRevision is required');
  const body = await request(`/api/crew-runs/${idPath(id)}/${command}`, jsonInit('POST', input));
  return runFrom(body.run);
}
