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

export async function fetchProjects(base = ''): Promise<Project[]> {
  try {
    const res = await fetch(`${base}/api/projects`);
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data) ? (data as Project[]) : [];
  } catch {
    return [];
  }
}

export async function fetchRecentProjects(
  base = '',
): Promise<Array<{ path: string; name?: string }>> {
  try {
    const res = await fetch(`${base}/api/projects/recent`);
    if (!res.ok) return [];
    const data = await res.json();
    const items = Array.isArray(data?.items) ? data.items : [];
    return items
      .filter((item: unknown): item is { path: string; name?: string } =>
        typeof (item as { path?: unknown })?.path === 'string')
      .map((item: { path: string; name?: string }) => ({ path: item.path, name: item.name }));
  } catch {
    return [];
  }
}

/** Fire-and-forget: persist a project selection server-side. */
export function recordRecentProject(path: string): void {
  void fetch('/api/projects/recent', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path }),
  }).catch(() => {
    // Offline or server error — localStorage recents still cover this device.
  });
}

export async function fetchBranches(projectPath: string, base = ''): Promise<Branch[]> {
  const res = await fetch(`${base}/api/projects/branches?path=${encodeURIComponent(projectPath)}`);
  if (!res.ok) throw new Error('Failed to load branches');
  const data = await res.json();
  return Array.isArray(data) ? (data as Branch[]) : [];
}
