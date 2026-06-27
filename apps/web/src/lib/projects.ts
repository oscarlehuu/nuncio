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

export function projectDisplayName(path: string | null | undefined): string | null {
  if (!path) return null;
  const parts = path.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

export async function fetchProjects(): Promise<Project[]> {
  try {
    const res = await fetch('/api/projects');
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data) ? (data as Project[]) : [];
  } catch {
    return [];
  }
}

export async function fetchBranches(projectPath: string): Promise<Branch[]> {
  const res = await fetch(`/api/projects/branches?path=${encodeURIComponent(projectPath)}`);
  if (!res.ok) throw new Error('Failed to load branches');
  const data = await res.json();
  return Array.isArray(data) ? (data as Branch[]) : [];
}
