import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fetchBranches, fetchProjects, fetchRecentProjects, projectDisplayName, recordRecentProject,
} from './projects';

function jsonRes(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: () => Promise.resolve(body) } as Response;
}

describe('projectDisplayName', () => {
  it('returns the last path segment, tolerating trailing slashes', () => {
    expect(projectDisplayName('/Users/me/code/nuncio')).toBe('nuncio');
    expect(projectDisplayName('/Users/me/code/nuncio/')).toBe('nuncio');
    expect(projectDisplayName(null)).toBeNull();
    expect(projectDisplayName(undefined)).toBeNull();
    expect(projectDisplayName('')).toBeNull();
  });
});

describe('projects api', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fetchProjects returns the array and degrades to [] on error, non-OK, or bad shape', async () => {
    const projects = [{ id: 'p1', name: 'nuncio', path: '/repo', isGit: true }];
    fetchMock.mockResolvedValue(jsonRes(projects));
    await expect(fetchProjects('https://mac.test')).resolves.toEqual(projects);
    expect(fetchMock).toHaveBeenCalledWith('https://mac.test/api/projects');

    fetchMock.mockResolvedValue(jsonRes(null, false, 500));
    await expect(fetchProjects()).resolves.toEqual([]);
    fetchMock.mockResolvedValue(jsonRes({ not: 'an array' }));
    await expect(fetchProjects()).resolves.toEqual([]);
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    await expect(fetchProjects()).resolves.toEqual([]);
  });

  it('fetchRecentProjects keeps only items with a string path and degrades to []', async () => {
    fetchMock.mockResolvedValue(jsonRes({ items: [
      { path: '/repo', name: 'nuncio' }, { path: 42 }, 'junk', { name: 'no-path' },
    ] }));
    await expect(fetchRecentProjects()).resolves.toEqual([{ path: '/repo', name: 'nuncio' }]);

    fetchMock.mockResolvedValue(jsonRes({}));
    await expect(fetchRecentProjects()).resolves.toEqual([]);
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    await expect(fetchRecentProjects()).resolves.toEqual([]);
  });

  it('recordRecentProject fires a POST and swallows failures', () => {
    fetchMock.mockRejectedValue(new TypeError('offline'));
    expect(() => recordRecentProject('/repo')).not.toThrow();
    expect(fetchMock).toHaveBeenCalledWith('/api/projects/recent', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ path: '/repo' }),
    }));
  });

  it('fetchBranches encodes the project path and throws on non-OK', async () => {
    const branches = [{ name: 'main', isDefault: true, isCurrent: true }];
    fetchMock.mockResolvedValue(jsonRes(branches));
    await expect(fetchBranches('/my repo')).resolves.toEqual(branches);
    expect(fetchMock).toHaveBeenCalledWith('/api/projects/branches?path=%2Fmy%20repo');

    fetchMock.mockResolvedValue(jsonRes(null, false, 500));
    await expect(fetchBranches('/repo')).rejects.toThrow('Failed to load branches');
    fetchMock.mockResolvedValue(jsonRes({ not: 'array' }));
    await expect(fetchBranches('/repo')).resolves.toEqual([]);
  });
});
