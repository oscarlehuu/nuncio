import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock('@nuncio/core/http', () => ({ apiFetch }));

import { fetchBranches, fetchProjects, preferredBaseBranch } from './projects';

describe('fetchProjects', () => {
  beforeEach(() => apiFetch.mockReset());

  it('loads the focused project list through the configured native API client', async () => {
    const projects = [{ id: 'repo', name: 'Nuncio', path: '/code/nuncio', isGit: true }];
    apiFetch.mockResolvedValue({ ok: true, json: async () => projects });

    await expect(fetchProjects()).resolves.toEqual(projects);
    expect(apiFetch).toHaveBeenCalledWith('/api/projects');
  });

  it('surfaces offline/server failure instead of presenting an empty ready list', async () => {
    apiFetch.mockResolvedValue({ ok: false, status: 503 });
    await expect(fetchProjects()).rejects.toThrow('Could not load projects');
  });

  it('loads branches and chooses a non-session current branch before the default', async () => {
    const branches = [
      { name: 'main', isDefault: true, isCurrent: false },
      { name: 'release', isDefault: false, isCurrent: true },
      { name: 'nuncio/deadbeef-run-generated', isDefault: false, isCurrent: false },
      { name: 'origin/nuncio/deadbeef-remote-generated', isDefault: false, isCurrent: false },
      { name: 'origin/feature/remote', isDefault: false, isCurrent: false },
    ];
    apiFetch.mockResolvedValue({ ok: true, json: async () => branches });

    await expect(fetchBranches('/code/nuncio')).resolves.toEqual(branches);
    expect(apiFetch).toHaveBeenCalledWith(
      '/api/projects/branches?path=%2Fcode%2Fnuncio',
    );
    expect(preferredBaseBranch(branches)).toBe('release');
    expect(preferredBaseBranch(branches, 'main')).toBe('main');
    expect(preferredBaseBranch(branches, 'nuncio/deadbeef-run-generated')).toBe('release');
    expect(preferredBaseBranch(branches, 'origin/nuncio/deadbeef-remote-generated')).toBe('release');
    expect(preferredBaseBranch(branches, 'origin/feature/remote')).toBe('origin/feature/remote');
  });

  it('surfaces branch loading failure instead of resolving the default silently', async () => {
    apiFetch.mockResolvedValue({ ok: false, status: 503 });
    await expect(fetchBranches('/code/nuncio')).rejects.toThrow('Could not load branches');
  });
});
