import { apiFetch } from '@nuncio/core/http';

export interface Project {
  id: string;
  name: string;
  path: string;
  isGit: true;
}

export interface Branch {
  name: string;
  isDefault: boolean;
  isCurrent: boolean;
}

const NUNCIO_SESSION_BRANCH = /^(?:[^/]+\/)?nuncio\/[0-9a-f]{8}-/i;

export async function fetchProjects(): Promise<Project[]> {
  const response = await apiFetch('/api/projects');
  if (!response.ok) throw new Error('Could not load projects');
  const body = (await response.json()) as unknown;
  if (!Array.isArray(body)) throw new Error('Could not load projects');
  return body.filter((value): value is Project => {
    if (!value || typeof value !== 'object') return false;
    const project = value as Partial<Project>;
    return (
      typeof project.id === 'string' &&
      typeof project.name === 'string' &&
      typeof project.path === 'string' &&
      project.isGit === true
    );
  });
}

export async function fetchBranches(projectPath: string): Promise<Branch[]> {
  const response = await apiFetch(
    `/api/projects/branches?path=${encodeURIComponent(projectPath)}`,
  );
  if (!response.ok) throw new Error('Could not load branches');
  const body = (await response.json()) as unknown;
  if (!Array.isArray(body)) throw new Error('Could not load branches');
  return body.filter((value): value is Branch => {
    if (!value || typeof value !== 'object') return false;
    const branch = value as Partial<Branch>;
    return typeof branch.name === 'string'
      && typeof branch.isDefault === 'boolean'
      && typeof branch.isCurrent === 'boolean';
  });
}

export function selectableBranches(branches: Branch[]): Branch[] {
  return branches.filter((branch) => !NUNCIO_SESSION_BRANCH.test(branch.name));
}

export function preferredBaseBranch(branches: Branch[], current = ''): string {
  const selectable = selectableBranches(branches);
  if (selectable.some((branch) => branch.name === current)) return current;
  return selectable.find((branch) => branch.isCurrent)?.name
    ?? selectable.find((branch) => branch.isDefault)?.name
    ?? selectable[0]?.name
    ?? '';
}
