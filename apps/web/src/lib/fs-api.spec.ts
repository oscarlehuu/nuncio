import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  deleteEntry, fetchDirectories, listEntries, makeDir, readFile, renameEntry, writeFile,
} from './fs-api';

function jsonRes(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: () => Promise.resolve(body) } as Response;
}

describe('fs-api', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fetchDirectories GETs the dirs route, encoding the optional path', async () => {
    const listing = { current: '/Users/me', parent: '/Users', entries: [] };
    fetchMock.mockResolvedValue(jsonRes(listing));

    await expect(fetchDirectories()).resolves.toEqual(listing);
    expect(fetchMock).toHaveBeenCalledWith('/api/fs/dirs');

    await expect(fetchDirectories('/Users/me/My Repos', 'https://mac.test')).resolves.toEqual(listing);
    expect(fetchMock).toHaveBeenLastCalledWith(
      'https://mac.test/api/fs/dirs?path=%2FUsers%2Fme%2FMy%20Repos',
    );
  });

  it('listEntries and readFile pass root + path as query params', async () => {
    const listing = { root: '/repo', path: 'src', parent: '', entries: [] };
    fetchMock.mockResolvedValue(jsonRes(listing));
    await expect(listEntries('/repo', 'src')).resolves.toEqual(listing);
    expect(fetchMock).toHaveBeenCalledWith('/api/fs/entries?root=%2Frepo&path=src');

    const file = { path: 'a.md', content: '# hi', encoding: 'utf8', truncated: false, size: 4 };
    fetchMock.mockResolvedValue(jsonRes(file));
    await expect(readFile('/repo', 'a.md')).resolves.toEqual(file);
    expect(fetchMock).toHaveBeenLastCalledWith('/api/fs/file?root=%2Frepo&path=a.md');
  });

  it('writeFile, makeDir, renameEntry, deleteEntry send JSON mutation bodies', async () => {
    fetchMock.mockResolvedValue(jsonRes({ path: 'a.md', size: 4 }));
    await writeFile('/repo', 'a.md', '# hi');
    expect(fetchMock).toHaveBeenLastCalledWith('/api/fs/file', expect.objectContaining({
      method: 'PUT', body: JSON.stringify({ root: '/repo', path: 'a.md', content: '# hi' }),
    }));

    fetchMock.mockResolvedValue(jsonRes({ path: 'docs' }));
    await makeDir('/repo', 'docs');
    expect(fetchMock).toHaveBeenLastCalledWith('/api/fs/dir', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ root: '/repo', path: 'docs' }),
    }));

    fetchMock.mockResolvedValue(jsonRes({ from: 'a.md', to: 'b.md' }));
    await renameEntry('/repo', 'a.md', 'b.md');
    expect(fetchMock).toHaveBeenLastCalledWith('/api/fs/rename', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ root: '/repo', from: 'a.md', to: 'b.md' }),
    }));

    fetchMock.mockResolvedValue(jsonRes({ path: 'b.md' }));
    await deleteEntry('/repo', 'b.md');
    expect(fetchMock).toHaveBeenLastCalledWith('/api/fs/entry', expect.objectContaining({
      method: 'DELETE', body: JSON.stringify({ root: '/repo', path: 'b.md' }),
    }));
  });

  it('maps a 404 to the stale-backend hint', async () => {
    fetchMock.mockResolvedValue({
      ok: false, status: 404, json: () => Promise.resolve({ message: 'not found' }),
    } as Response);
    await expect(listEntries('/repo')).rejects.toThrow(
      'Failed to load files: /api/fs/entries returned 404 (restart the backend server to pick up the new route)',
    );
  });

  it('includes the server message on other HTTP errors and tolerates non-JSON bodies', async () => {
    fetchMock.mockResolvedValue({
      ok: false, status: 403, json: () => Promise.resolve({ message: 'outside root' }),
    } as Response);
    await expect(readFile('/repo', '../etc/passwd')).rejects.toThrow(
      'Failed to read file (HTTP 403: outside root)',
    );

    fetchMock.mockResolvedValue({
      ok: false, status: 500, json: () => Promise.reject(new Error('not json')),
    } as Response);
    await expect(readFile('/repo', 'a.md')).rejects.toThrow('Failed to read file (HTTP 500)');
  });

  it('maps network failures to the backend-down hint', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    await expect(fetchDirectories()).rejects.toThrow(
      'Failed to load directories (network — is the backend running on :3000?)',
    );
  });
});
