import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fetchForgeIssues,
  fetchForgePullComments,
  fetchForgePulls,
  mergeForgePull,
  type ForgeComment,
  type ForgeIssueSummary,
  type ForgePullRequestSummary,
} from './forge-api';

function jsonRes(body: unknown, ok = true): Response {
  return {
    ok,
    json: () => Promise.resolve(body),
    catch: () => null,
  } as unknown as Response;
}

const REPO = '/Users/me/nuncio';

describe('forge-api', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fetchForgePulls GETs pulls with encoded path and state', async () => {
    const pulls: ForgePullRequestSummary[] = [
      {
        number: 12,
        title: 'Add forge UI',
        state: 'open',
        draft: false,
        author: 'octo',
        sourceBranch: 'feat/forge',
        targetBranch: 'main',
        url: 'https://github.com/octo/nuncio/pull/12',
        updatedAt: '2026-01-01T00:00:00Z',
        commentCount: 3,
      },
    ];
    fetchMock.mockResolvedValue(jsonRes(pulls));

    await expect(fetchForgePulls(REPO, 'open')).resolves.toEqual(pulls);
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/forge/pulls?path=${encodeURIComponent(REPO)}&state=open`,
      undefined,
    );
  });

  it('fetchForgeIssues GETs issues with encoded path and state', async () => {
    const issues: ForgeIssueSummary[] = [
      {
        number: 7,
        title: 'Bug report',
        state: 'open',
        author: 'octo',
        labels: ['bug'],
        assignees: [],
        commentCount: 0,
        updatedAt: '2026-01-02T00:00:00Z',
        url: 'https://github.com/octo/nuncio/issues/7',
      },
    ];
    fetchMock.mockResolvedValue(jsonRes(issues));

    await expect(fetchForgeIssues(REPO, 'closed')).resolves.toEqual(issues);
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/forge/issues?path=${encodeURIComponent(REPO)}&state=closed`,
      undefined,
    );
  });

  it('fetchForgePullComments GETs conversation comments for a pull', async () => {
    const comments: ForgeComment[] = [
      {
        id: '101',
        author: 'bot',
        body: 'first',
        createdAt: '2026-07-19T12:00:00Z',
      },
      {
        id: '102',
        author: 'oscar',
        body: 'second',
        createdAt: '2026-07-19T13:00:00Z',
      },
    ];
    fetchMock.mockResolvedValue(jsonRes(comments));

    await expect(fetchForgePullComments(REPO, 128)).resolves.toEqual(comments);
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/forge/pulls/128/comments?path=${encodeURIComponent(REPO)}`,
      undefined,
    );
  });

  it('mergeForgePull POSTs merge options and returns the result', async () => {
    const merged = { merged: true, sha: 'abc123', message: 'Merged' };
    fetchMock.mockResolvedValue(jsonRes(merged));

    await expect(
      mergeForgePull(REPO, 12, { method: 'squash', deleteSourceBranch: true }),
    ).resolves.toEqual(merged);
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/forge/pulls/12/merge?path=${encodeURIComponent(REPO)}`,
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ method: 'squash', deleteSourceBranch: true }),
      }),
    );
  });

  it('uses server message from JSON error body when present', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      json: async () => ({ message: 'Checks have not passed' }),
    });
    await expect(fetchForgePulls(REPO, 'open')).rejects.toThrow('Checks have not passed');
  });

  it('falls back to endpoint-specific message when error body is empty', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      json: async () => null,
    });
    await expect(fetchForgePulls(REPO, 'open')).rejects.toThrow('Failed to load pull requests');
  });

  it('falls back when error response JSON parse throws', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      json: async () => {
        throw new Error('invalid json');
      },
    });
    await expect(
      mergeForgePull(REPO, 1, { method: 'merge' }),
    ).rejects.toThrow('Failed to merge');
  });
});
