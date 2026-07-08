import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  cloneForgeRepo,
  createLoop,
  deleteLoop,
  deleteProjectConfig,
  fetchForgeRepos,
  fetchLoop,
  fetchLoopRunDetail,
  fetchLoopRuns,
  fetchLoops,
  fetchLoopStats,
  fetchProjectConfigs,
  fireLoop,
  pauseLoop,
  resumeLoop,
  updateLoop,
  upsertProjectConfig,
} from './api';

function jsonRes(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: () => Promise.resolve(body), text: () => Promise.resolve('') } as Response;
}

describe('loops api client', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fetchLoops unwraps the items envelope', async () => {
    fetchMock.mockResolvedValue(jsonRes({ items: [{ id: 'l1' }, { id: 'l2' }] }));
    const loops = await fetchLoops();
    expect(fetchMock).toHaveBeenCalledWith('/api/loops');
    expect(loops.map((l) => l.id)).toEqual(['l1', 'l2']);
  });

  it('fetchLoops tolerates a missing items key', async () => {
    fetchMock.mockResolvedValue(jsonRes({}));
    expect(await fetchLoops()).toEqual([]);
  });

  it('fetchLoop reads one loop by id', async () => {
    fetchMock.mockResolvedValue(jsonRes({ id: 'l9' }));
    const loop = await fetchLoop('l9');
    expect(fetchMock).toHaveBeenCalledWith('/api/loops/l9');
    expect(loop.id).toBe('l9');
  });

  it('createLoop posts the goal + schedule + budget', async () => {
    fetchMock.mockResolvedValue(jsonRes({ id: 'new' }));
    await createLoop({
      goal: 'tidy up flaky tests',
      schedule: { kind: 'cron', spec: 'daily@22:00' },
      maxRunsPerDay: 12,
      stop: { kind: 'maxTotalRuns', n: 5 },
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/loops');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toMatchObject({
      goal: 'tidy up flaky tests',
      schedule: { kind: 'cron', spec: 'daily@22:00' },
      maxRunsPerDay: 12,
      stop: { kind: 'maxTotalRuns', n: 5 },
    });
  });

  it('createLoop posts the per-loop engine + model overrides', async () => {
    fetchMock.mockResolvedValue(jsonRes({ id: 'new' }));
    await createLoop({
      goal: 'nightly refactor',
      schedule: { kind: 'cron', spec: 'daily@22:00' },
      engine: 'pi',
      model: 'claude-fable-5',
    });
    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(init.body)).toMatchObject({ engine: 'pi', model: 'claude-fable-5' });
  });

  it('createLoop surfaces the server error message', async () => {
    fetchMock.mockResolvedValue(jsonRes({ message: 'goal is required' }, false, 400));
    await expect(createLoop({ goal: '', schedule: { kind: 'cron', spec: 'daily@22:00' } })).rejects.toThrow(
      'goal is required',
    );
  });

  it('pauseLoop and resumeLoop POST to their endpoints', async () => {
    fetchMock.mockResolvedValue(jsonRes({ id: 'l1', status: 'paused' }));
    await pauseLoop('l1');
    expect(fetchMock).toHaveBeenCalledWith('/api/loops/l1/pause', { method: 'POST' });
    await resumeLoop('l1');
    expect(fetchMock).toHaveBeenCalledWith('/api/loops/l1/resume', { method: 'POST' });
  });

  it('deleteLoop issues a DELETE', async () => {
    fetchMock.mockResolvedValue(jsonRes({ ok: true }));
    await deleteLoop('l1');
    expect(fetchMock).toHaveBeenCalledWith('/api/loops/l1', { method: 'DELETE' });
  });

  it('fetchLoopRuns unwraps the items envelope', async () => {
    fetchMock.mockResolvedValue(jsonRes({ items: [{ id: 'r1' }] }));
    expect((await fetchLoopRuns('l1')).length).toBe(1);
    expect(fetchMock).toHaveBeenCalledWith('/api/loops/l1/runs');
  });

  it('updateLoop PATCHes editable fields', async () => {
    fetchMock.mockResolvedValue(jsonRes({ id: 'l1' }));
    await updateLoop('l1', { goal: 'new goal', engine: null });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/loops/l1');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body)).toEqual({ goal: 'new goal', engine: null });
  });

  it('updateLoop PATCHes the per-loop model override (null clears it)', async () => {
    fetchMock.mockResolvedValue(jsonRes({ id: 'l1' }));
    await updateLoop('l1', { model: 'claude-fable-5' });
    let [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/loops/l1');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body)).toEqual({ model: 'claude-fable-5' });
    await updateLoop('l1', { engine: null, model: null });
    [url, init] = fetchMock.mock.calls[1]!;
    expect(JSON.parse(init.body)).toEqual({ engine: null, model: null });
  });

  it('fetchLoop round-trips the per-loop model override', async () => {
    fetchMock.mockResolvedValue(jsonRes({ id: 'l9', engine: 'pi', model: 'claude-fable-5' }));
    const loop = await fetchLoop('l9');
    expect(loop.engine).toBe('pi');
    expect(loop.model).toBe('claude-fable-5');
  });

  it('fireLoop POSTs to /fire and returns the started run on 200', async () => {
    fetchMock.mockResolvedValue(jsonRes({ id: 'r9', outcome: 'pending' }));
    const result = await fireLoop('l1');
    expect(fetchMock).toHaveBeenCalledWith('/api/loops/l1/fire', { method: 'POST' });
    expect(result).toEqual({ fired: true, run: { id: 'r9', outcome: 'pending' } });
  });

  it('fireLoop reports a 409 skip with its reason (not an error)', async () => {
    fetchMock.mockResolvedValue(jsonRes({ reason: 'overlap' }, false, 409));
    expect(await fireLoop('l1')).toEqual({ fired: false, reason: 'overlap' });
    fetchMock.mockResolvedValue(jsonRes({ reason: 'budget' }, false, 409));
    expect(await fireLoop('l1')).toEqual({ fired: false, reason: 'budget' });
  });

  it('fireLoop defaults a reason-less 409 to overlap, and throws on other errors', async () => {
    fetchMock.mockResolvedValue(jsonRes({}, false, 409));
    expect(await fireLoop('l1')).toEqual({ fired: false, reason: 'overlap' });
    fetchMock.mockResolvedValue(jsonRes({ message: 'loop is paused' }, false, 400));
    await expect(fireLoop('l1')).rejects.toThrow('loop is paused');
  });

  it('fetchLoopRunDetail reads one run drill-down', async () => {
    fetchMock.mockResolvedValue(jsonRes({ id: 'r1', sessionId: 's1' }));
    const detail = await fetchLoopRunDetail('l1', 'r1');
    expect(fetchMock).toHaveBeenCalledWith('/api/loops/l1/runs/r1');
    expect(detail.sessionId).toBe('s1');
  });

  it('fetchLoopStats reads the dashboard payload', async () => {
    fetchMock.mockResolvedValue(jsonRes({ total: 3, sparkline: [] }));
    const stats = await fetchLoopStats();
    expect(fetchMock).toHaveBeenCalledWith('/api/loops/stats');
    expect(stats.total).toBe(3);
  });
});

describe('forge repo + clone api client', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fetchForgeRepos passes a search query', async () => {
    fetchMock.mockResolvedValue(jsonRes({ items: [{ id: '1', fullName: 'me/repo' }] }));
    await fetchForgeRepos('github', 'my repo');
    expect(fetchMock).toHaveBeenCalledWith('/api/forges/github/repos?q=my%20repo');
  });

  it('fetchForgeRepos omits the query param when empty', async () => {
    fetchMock.mockResolvedValue(jsonRes({ items: [] }));
    await fetchForgeRepos('github', '   ');
    expect(fetchMock).toHaveBeenCalledWith('/api/forges/github/repos');
  });

  it('cloneForgeRepo POSTs the clone request and returns the path', async () => {
    fetchMock.mockResolvedValue(jsonRes({ path: '/Users/me/cloned' }));
    const { path } = await cloneForgeRepo({ forgeId: 'github', fullName: 'me/repo', cloneUrl: 'https://x/y.git' });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/projects/clone');
    expect(init.method).toBe('POST');
    expect(path).toBe('/Users/me/cloned');
  });
});

describe('project config api client', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fetchProjectConfigs unwraps the items envelope', async () => {
    fetchMock.mockResolvedValue(jsonRes({ items: [{ path: '/a' }] }));
    expect((await fetchProjectConfigs())[0]!.path).toBe('/a');
    expect(fetchMock).toHaveBeenCalledWith('/api/projects/config');
  });

  it('upsertProjectConfig PUTs the patch', async () => {
    fetchMock.mockResolvedValue(jsonRes({ path: '/a' }));
    await upsertProjectConfig({ path: '/a', verifyCommand: 'bun test' });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/projects/config');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body)).toEqual({ path: '/a', verifyCommand: 'bun test' });
  });

  it('deleteProjectConfig passes the path as a query param', async () => {
    fetchMock.mockResolvedValue(jsonRes({ ok: true }));
    await deleteProjectConfig('/Users/me/proj');
    expect(fetchMock).toHaveBeenCalledWith('/api/projects/config?path=%2FUsers%2Fme%2Fproj', {
      method: 'DELETE',
    });
  });
});
