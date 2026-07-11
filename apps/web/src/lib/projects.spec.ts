import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchBranches } from './projects';

describe('fetchBranches', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('routes branch requests through the selected machine API base', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [{ name: 'origin/dev', isDefault: false, isCurrent: false }],
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchBranches('/code/nuncio workspace', '/m/studio')).resolves.toEqual([
      { name: 'origin/dev', isDefault: false, isCurrent: false },
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      '/m/studio/api/projects/branches?path=%2Fcode%2Fnuncio%20workspace',
    );
  });
});
