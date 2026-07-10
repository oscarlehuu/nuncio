import { apiFetch } from '@nuncio/core/http';

export interface CrewProject {
  id: string;
  name: string;
  path: string;
  isGit: true;
}

export interface CrewBranch {
  name: string;
  isDefault: boolean;
  isCurrent: boolean;
}

const NUNCIO_SESSION_BRANCH = /^nuncio\/[0-9a-f]{8}-/i;

export async function fetchCrewProjects(): Promise<CrewProject[]> {
  const response = await apiFetch('/api/projects');
  if (!response.ok) throw new Error('Could not load projects');
  const body = (await response.json()) as unknown;
  if (!Array.isArray(body)) throw new Error('Could not load projects');
  return body.filter((value): value is CrewProject => {
    if (!value || typeof value !== 'object') return false;
    const project = value as Partial<CrewProject>;
    return (
      typeof project.id === 'string' &&
      typeof project.name === 'string' &&
      typeof project.path === 'string' &&
      project.isGit === true
    );
  });
}

export async function fetchCrewBranches(projectPath: string): Promise<CrewBranch[]> {
  const response = await apiFetch(
    `/api/projects/branches?path=${encodeURIComponent(projectPath)}`,
  );
  if (!response.ok) throw new Error('Could not load branches');
  const body = (await response.json()) as unknown;
  if (!Array.isArray(body)) throw new Error('Could not load branches');
  return body.filter((value): value is CrewBranch => {
    if (!value || typeof value !== 'object') return false;
    const branch = value as Partial<CrewBranch>;
    return typeof branch.name === 'string'
      && typeof branch.isDefault === 'boolean'
      && typeof branch.isCurrent === 'boolean';
  });
}

export function selectableCrewBranches(branches: CrewBranch[]): CrewBranch[] {
  return branches.filter((branch) => !NUNCIO_SESSION_BRANCH.test(branch.name));
}

export function preferredCrewBaseBranch(
  branches: CrewBranch[], current = '',
): string {
  const selectable = selectableCrewBranches(branches);
  if (selectable.some((branch) => branch.name === current)) return current;
  return selectable.find((branch) => branch.isCurrent)?.name
    ?? selectable.find((branch) => branch.isDefault)?.name
    ?? selectable[0]?.name
    ?? '';
}
