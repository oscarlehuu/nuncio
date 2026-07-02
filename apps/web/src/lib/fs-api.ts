/** API client for server-side filesystem browsing. */

export interface DirEntry {
  name: string;
  path: string;
  isGit: boolean;
}

export interface DirListing {
  current: string;
  parent: string | null;
  entries: DirEntry[];
}

export interface FileEntry {
  name: string;
  path: string;
  kind: 'file' | 'dir';
  size?: number;
  isSymlink?: boolean;
}

export interface FileListing {
  root: string;
  path: string;
  parent: string | null;
  entries: FileEntry[];
}

export type FileReadResult =
  | { path: string; content: string; encoding: 'utf8'; truncated: false; size: number }
  | { path: string; encoding: 'utf8'; truncated: true; size: number; binary?: false }
  | { path: string; binary: true; size: number };

async function parseFsError(res: Response, label: string, route: string): Promise<Error> {
  let detail = '';
  try {
    const body = await res.json();
    detail = body?.message ? `: ${body.message}` : '';
  } catch {
    // non-JSON body — skip
  }
  if (res.status === 404) {
    return new Error(`${label}: ${route} returned 404 (restart the backend server to pick up the new route)`);
  }
  return new Error(`${label} (HTTP ${res.status}${detail})`);
}

async function fetchJson<T>(url: string, init: RequestInit | undefined, label: string): Promise<T> {
  let res: Response;
  try {
    res = init === undefined ? await fetch(url) : await fetch(url, init);
  } catch {
    throw new Error(`${label} (network — is the backend running on :3000?)`);
  }
  if (!res.ok) throw await parseFsError(res, label, url.split('?')[0]);
  return res.json();
}

/**
 * List subdirectories of `path` on the host machine. Omit `path` to start at
 * the user's home directory. Browsers cannot browse the host filesystem
 * directly, so the server lists directories on behalf of the client — this
 * works on every client including the iPhone PWA.
 */
export async function fetchDirectories(path?: string): Promise<DirListing> {
  const url = path ? `/api/fs/dirs?path=${encodeURIComponent(path)}` : '/api/fs/dirs';
  return fetchJson<DirListing>(url, undefined, 'Failed to load directories');
}

export async function listEntries(root: string, path = ''): Promise<FileListing> {
  const params = new URLSearchParams({ root, path });
  return fetchJson<FileListing>(`/api/fs/entries?${params.toString()}`, undefined, 'Failed to load files');
}

export async function readFile(root: string, path: string): Promise<FileReadResult> {
  const params = new URLSearchParams({ root, path });
  return fetchJson<FileReadResult>(`/api/fs/file?${params.toString()}`, undefined, 'Failed to read file');
}

export async function writeFile(root: string, path: string, content: string): Promise<{ path: string; size: number }> {
  return fetchJson('/api/fs/file', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ root, path, content }),
  }, 'Failed to save file');
}

export async function makeDir(root: string, path: string): Promise<{ path: string }> {
  return fetchJson('/api/fs/dir', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ root, path }),
  }, 'Failed to create folder');
}

export async function renameEntry(root: string, from: string, to: string): Promise<{ from: string; to: string }> {
  return fetchJson('/api/fs/rename', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ root, from, to }),
  }, 'Failed to rename entry');
}

export async function deleteEntry(root: string, path: string): Promise<{ path: string }> {
  return fetchJson('/api/fs/entry', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ root, path }),
  }, 'Failed to delete entry');
}
