import type { CreateCrewTaskInput, ResolvedCrewProfileDto } from '@nuncio/core/crew-api';

export type CrewExecutionMode = 'solo' | 'crew';
export type SoloCreateArgs = [prompt: string, model?: string, provider?: string];

export function initialExecutionMode(): CrewExecutionMode {
  return 'solo';
}

export function buildSoloCreateArgs(
  prompt: string,
  selected?: { id: string; providerId: string },
): SoloCreateArgs {
  return [prompt.trim(), selected?.id, selected?.providerId];
}

export function buildCrewTaskInput(input: {
  objective: string;
  projectPath: string;
  profileId: string;
  baseBranch?: string;
}): CreateCrewTaskInput | null {
  const objective = input.objective.trim();
  const projectPath = input.projectPath.trim();
  const profileId = input.profileId.trim();
  if (!objective || !projectPath || !profileId) return null;
  const request: CreateCrewTaskInput = { objective, projectPath, profileId };
  const baseBranch = input.baseBranch?.trim();
  if (baseBranch) request.baseBranch = baseBranch;
  return request;
}

export function shouldApplyCrewResolution(
  requestId: number,
  currentRequestId: number,
  aborted = false,
): boolean {
  return requestId === currentRequestId && !aborted;
}

export function crewResolutionKey(profileId: string, projectPath: string): string {
  return JSON.stringify([profileId.trim(), projectPath.trim()]);
}

export function isCrewResolutionCurrent(
  resolvedFor: string | null,
  profileId: string,
  projectPath: string,
): boolean {
  return resolvedFor !== null && resolvedFor === crewResolutionKey(profileId, projectPath);
}

export function resolvedCrewTeam(resolution: ResolvedCrewProfileDto): string[] {
  const { bindings } = resolution.snapshot;
  const label = (role: keyof typeof bindings) => bindings[role].label || bindings[role].model;
  return [
    `Foreman · ${label('foreman')}`,
    `Builder · ${label('builder')}`,
    'Tester · Nuncio Tester',
    `Reviewer · ${label('reviewer')}`,
  ];
}

export function crewProfileSettingsUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/settings?section=crew-profiles`;
}

export interface CrewSubmitLock {
  tryAcquire(): boolean;
  release(): void;
}

export function createCrewSubmitLock(): CrewSubmitLock {
  let locked = false;
  return {
    tryAcquire() {
      if (locked) return false;
      locked = true;
      return true;
    },
    release() {
      locked = false;
    },
  };
}
