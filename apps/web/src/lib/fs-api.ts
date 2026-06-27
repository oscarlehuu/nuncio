/** API client for the server-side directory browser (`GET /api/fs/dirs`). */

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

/**
 * List subdirectories of `path` on the host machine. Omit `path` to start at
 * the user's home directory. Browsers cannot browse the host filesystem
 * directly, so the server lists directories on behalf of the client — this
 * works on every client including the iPhone PWA.
 */
export async function fetchDirectories(path?: string): Promise<DirListing> {
  const url = path ? `/api/fs/dirs?path=${encodeURIComponent(path)}` : '/api/fs/dirs';
  let res: Response;
  try {
    res = await fetch(url);
  } catch {
    throw new Error('Failed to load directories (network — is the backend running on :3000?)');
  }
  if (!res.ok) {
    // Surface the real reason: 404 → backend needs restart (route missing),
    // 400 → bad path, etc. Try to read the server's error message too.
    let detail = '';
    try {
      const body = await res.json();
      detail = body?.message ? `: ${body.message}` : '';
    } catch {
      // non-JSON body — skip
    }
    if (res.status === 404) {
      throw new Error(
        'Failed to load directories: /api/fs/dirs returned 404 (restart the backend server to pick up the new route)',
      );
    }
    throw new Error(`Failed to load directories (HTTP ${res.status}${detail})`);
  }
  return res.json();
}
