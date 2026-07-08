import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchFleet } from './fleet-api';

function jsonRes(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: () => Promise.resolve(body), text: () => Promise.resolve('') } as Response;
}

describe('fleet api client', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns rows in server order (red first) — no re-sort', async () => {
    fetchMock.mockResolvedValue(
      jsonRes({
        items: [
          { path: '/red', name: 'red', weight: 1, health: 'red', reasons: ['1 need you'], counts: {}, lastActivityAt: 2 },
          { path: '/green', name: 'green', weight: 1, health: 'green', reasons: [], counts: {}, lastActivityAt: 1 },
        ],
      }),
    );
    const rows = await fetchFleet();
    expect(fetchMock).toHaveBeenCalledWith('/api/fleet');
    expect(rows.map((r) => r.path)).toEqual(['/red', '/green']);
  });

  it('fills a partial row so a legacy shape still renders', async () => {
    fetchMock.mockResolvedValue(jsonRes({ items: [{ path: '/p' }] }));
    const [row] = await fetchFleet();
    expect(row).toMatchObject({
      path: '/p',
      name: '/p',
      weight: 1,
      health: 'green',
      reasons: [],
      topItem: null,
      counts: { openAttention: 0, runningSessions: 0, activeLoops: 0, openPRs: 0 },
      lastActivityAt: null,
    });
  });

  it('drops a row with no path (defensive)', async () => {
    fetchMock.mockResolvedValue(jsonRes({ items: [{ name: 'orphan' }, { path: '/keep' }] }));
    const rows = await fetchFleet();
    expect(rows.map((r) => r.path)).toEqual(['/keep']);
  });

  it('tolerates a missing items key', async () => {
    fetchMock.mockResolvedValue(jsonRes({}));
    expect(await fetchFleet()).toEqual([]);
  });

  it('surfaces a load error', async () => {
    fetchMock.mockResolvedValue(jsonRes({}, false, 500));
    await expect(fetchFleet()).rejects.toThrow(/fleet/i);
  });
});
