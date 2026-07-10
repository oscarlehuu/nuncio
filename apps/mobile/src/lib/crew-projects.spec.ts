import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock('@nuncio/core/http', () => ({ apiFetch }));

import { fetchCrewProjects } from './crew-projects';

describe('fetchCrewProjects', () => {
  beforeEach(() => apiFetch.mockReset());

  it('loads the focused project list through the configured native API client', async () => {
    const projects = [{ id: 'repo', name: 'Nuncio', path: '/code/nuncio', isGit: true }];
    apiFetch.mockResolvedValue({ ok: true, json: async () => projects });

    await expect(fetchCrewProjects()).resolves.toEqual(projects);
    expect(apiFetch).toHaveBeenCalledWith('/api/projects');
  });

  it('surfaces offline/server failure instead of presenting an empty ready list', async () => {
    apiFetch.mockResolvedValue({ ok: false, status: 503 });
    await expect(fetchCrewProjects()).rejects.toThrow('Could not load projects');
  });
});
