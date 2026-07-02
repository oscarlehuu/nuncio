import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cancelTask, createTask, fetchTasks, retryTask } from './tasks-api';

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function ok(body: unknown) {
  return { ok: true, json: async () => body } as Response;
}

describe('tasks api', () => {
  it('fetchTasks GETs /api/tasks', async () => {
    fetchMock.mockResolvedValue(ok([]));
    await fetchTasks();
    expect(fetchMock).toHaveBeenCalledWith('/api/tasks');
  });

  it('createTask POSTs the task fields', async () => {
    fetchMock.mockResolvedValue(ok({ id: 't1' }));
    await createTask({
      prompt: 'ship it',
      provider: 'pi',
      model: 'pi:model',
      projectPath: '/code/nuncio',
      baseBranch: 'main',
      useWorktree: true,
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/tasks');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toMatchObject({
      prompt: 'ship it',
      provider: 'pi',
      useWorktree: true,
    });
  });

  it('cancel and retry POST to the task action endpoints', async () => {
    fetchMock.mockResolvedValue(ok({ id: 't1' }));
    await cancelTask('t1');
    expect(fetchMock).toHaveBeenLastCalledWith('/api/tasks/t1/cancel', { method: 'POST' });
    await retryTask('t1');
    expect(fetchMock).toHaveBeenLastCalledWith('/api/tasks/t1/retry', { method: 'POST' });
  });

  it('throws on a failed response', async () => {
    fetchMock.mockResolvedValue({ ok: false } as Response);
    await expect(fetchTasks()).rejects.toThrow();
  });
});
