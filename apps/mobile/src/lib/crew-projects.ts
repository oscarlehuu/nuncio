import { apiFetch } from '@nuncio/core/http';

export interface CrewProject {
  id: string;
  name: string;
  path: string;
  isGit: true;
}

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
