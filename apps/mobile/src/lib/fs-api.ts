import { apiFetch } from '@nuncio/core/http';

/**
 * Server-side filesystem browsing — the phone can't see the host's paths, so the
 * backend lists directories on its behalf (mirrors the web `fs-api`/FolderBrowser
 * against `GET /api/fs/dirs`).
 */
interface DirEntry {
  name: string;
  path: string;
  isGit: boolean;
}

export interface DirListing {
  current: string;
  parent: string | null;
  entries: DirEntry[];
}

/** List subdirectories of `path`. Omit `path` to start at the user's home dir. */
export async function fetchDirectories(path?: string): Promise<DirListing> {
  const url = path ? `/api/fs/dirs?path=${encodeURIComponent(path)}` : '/api/fs/dirs';
  const response = await apiFetch(url);
  if (!response.ok) throw new Error('Could not load directories');
  return (await response.json()) as DirListing;
}
