import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchTimeline } from './timeline-api';

function jsonRes(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: () => Promise.resolve(body), text: () => Promise.resolve('') } as Response;
}

describe('timeline api client', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fetchTimeline passes the window, cursor, and limit', async () => {
    fetchMock.mockResolvedValue(jsonRes({ entries: [{ id: 'e1', ts: 10 }], nextBefore: 10 }));
    const dto = await fetchTimeline({ from: 1, to: 20, before: 10, limit: 25 });
    expect(fetchMock).toHaveBeenCalledWith('/api/timeline?from=1&to=20&before=10&limit=25');
    expect(dto.nextBefore).toBe(10);
  });

  it('fetchTimeline tolerates missing fields', async () => {
    fetchMock.mockResolvedValue(jsonRes({}));
    await expect(fetchTimeline()).resolves.toEqual({ entries: [], nextBefore: null });
  });
});
