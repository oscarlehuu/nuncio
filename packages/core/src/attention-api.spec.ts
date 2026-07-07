import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  ackAttentionItem,
  fetchAttention,
  fetchAttentionCounts,
  fetchDigest,
  resolveAttentionItem,
} from './attention-api';

function jsonRes(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: () => Promise.resolve(body), text: () => Promise.resolve('') } as Response;
}

describe('attention api client', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fetchAttention returns items in server order + counts', async () => {
    fetchMock.mockResolvedValue(
      jsonRes({
        items: [{ id: 'a', kind: 'permission', severity: 5 }, { id: 'b', kind: 'pr-review', severity: 2 }],
        counts: { total: 2, unacked: 1, bySeverity: { '5': 1, '2': 1 } },
      }),
    );
    const { items, counts } = await fetchAttention();
    expect(fetchMock).toHaveBeenCalledWith('/api/attention');
    expect(items.map((i) => i.id)).toEqual(['a', 'b']); // rendered as-is, no re-sort
    expect(counts.unacked).toBe(1);
  });

  it('fetchAttention tolerates an unknown kind without throwing', async () => {
    fetchMock.mockResolvedValue(
      jsonRes({ items: [{ id: 'x', kind: 'brand-new-kind', severity: 0 }], counts: { total: 1, unacked: 1, bySeverity: {} } }),
    );
    const { items } = await fetchAttention();
    expect(items[0]!.kind).toBe('brand-new-kind');
  });

  it('fetchAttention defaults missing fields to an empty queue', async () => {
    fetchMock.mockResolvedValue(jsonRes({}));
    const { items, counts } = await fetchAttention();
    expect(items).toEqual([]);
    expect(counts).toEqual({ total: 0, unacked: 0, bySeverity: {} });
  });

  it('fetchAttentionCounts reads the badge numbers', async () => {
    fetchMock.mockResolvedValue(jsonRes({ total: 3, unacked: 2, bySeverity: { '5': 2 } }));
    const counts = await fetchAttentionCounts();
    expect(fetchMock).toHaveBeenCalledWith('/api/attention/counts');
    expect(counts.unacked).toBe(2);
  });

  it('ackAttentionItem POSTs to /ack and returns the item', async () => {
    fetchMock.mockResolvedValue(jsonRes({ id: 'a', acknowledgedAt: 123 }));
    const item = await ackAttentionItem('a');
    expect(fetchMock).toHaveBeenCalledWith('/api/attention/a/ack', { method: 'POST' });
    expect(item.acknowledgedAt).toBe(123);
  });

  it('resolveAttentionItem POSTs to /resolve', async () => {
    fetchMock.mockResolvedValue(jsonRes({ id: 'a', status: 'resolved' }));
    await resolveAttentionItem('a');
    expect(fetchMock).toHaveBeenCalledWith('/api/attention/a/resolve', { method: 'POST' });
  });

  it('surfaces a load error', async () => {
    fetchMock.mockResolvedValue(jsonRes({}, false, 500));
    await expect(fetchAttention()).rejects.toThrow(/attention queue/i);
  });
});

describe('digest api client', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const FULL = {
    slotKey: '2026-07-07:morning',
    variant: 'morning',
    sentAt: 1,
    windowFrom: 0,
    windowTo: 1,
    digest: {
      variant: 'morning',
      windowFrom: 0,
      windowTo: 1,
      loops: { runsOk: 3, runsFailed: 1, prsOpened: 2 },
      attention: { raised: 4, resolved: 2, openTopCount: 1 },
      sessions: { completed: 5, needsYou: 1 },
      budget: { runsToday: 6, cap: 24 },
    },
  };

  it('fetchDigest defaults to the latest slot', async () => {
    fetchMock.mockResolvedValue(jsonRes(FULL));
    const dto = await fetchDigest();
    expect(fetchMock).toHaveBeenCalledWith('/api/heartbeat/digest?slot=latest');
    expect(dto?.digest.loops.runsOk).toBe(3);
  });

  it('fetchDigest passes a specific slot key', async () => {
    fetchMock.mockResolvedValue(jsonRes(FULL));
    await fetchDigest('2026-07-06:evening');
    expect(fetchMock).toHaveBeenCalledWith('/api/heartbeat/digest?slot=2026-07-06%3Aevening');
  });

  it('fetchDigest returns null when no digest has been built yet', async () => {
    fetchMock.mockResolvedValue(jsonRes(null));
    expect(await fetchDigest()).toBeNull();
  });

  it('fetchDigest fills missing sections with zeros (partial payload)', async () => {
    fetchMock.mockResolvedValue(
      jsonRes({ slotKey: 's', variant: 'evening', sentAt: 1, windowFrom: 0, windowTo: 1, digest: { variant: 'evening' } }),
    );
    const dto = await fetchDigest();
    expect(dto?.digest.loops).toEqual({ runsOk: 0, runsFailed: 0, prsOpened: 0 });
    expect(dto?.digest.budget.cap).toBe(0);
    expect(dto?.variant).toBe('evening');
  });
});
