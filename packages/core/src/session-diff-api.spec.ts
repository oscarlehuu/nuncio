import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  fetchSessionDiff,
  postDiffComment,
  type SessionDiff,
} from './session-diff-api';

function jsonRes(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: () => Promise.resolve(body), text: () => Promise.resolve('') } as Response;
}

describe('session diff api client', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fetchSessionDiff loads the structured session diff', async () => {
    const diff: SessionDiff = {
      files: [
        {
          path: 'apps/web/src/app.tsx',
          oldPath: null,
          status: 'modified',
          additions: 2,
          deletions: 1,
          hunks: [
            {
              header: '@@ -1,2 +1,3 @@',
              oldStart: 1,
              oldLines: 2,
              newStart: 1,
              newLines: 3,
              lines: [{ kind: 'add', text: 'const next = true;' }],
            },
          ],
        },
      ],
      truncated: false,
      omittedFiles: 0,
    };
    fetchMock.mockResolvedValue(jsonRes(diff));

    await expect(fetchSessionDiff('s1')).resolves.toEqual(diff);
    expect(fetchMock).toHaveBeenCalledWith('/api/sessions/s1/diff');
  });

  it('postDiffComment sends the hunk comment to the session endpoint', async () => {
    fetchMock.mockResolvedValue(jsonRes({ ok: true }));

    await expect(
      postDiffComment('s1', {
        path: 'src/app.ts',
        startLine: 12,
        endLine: 14,
        hunk: '@@ -12,3 +12,3 @@\n+change',
        comment: 'Please simplify this branch.',
      }),
    ).resolves.toEqual({ ok: true });

    expect(fetchMock).toHaveBeenCalledWith('/api/sessions/s1/diff/comment', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        path: 'src/app.ts',
        startLine: 12,
        endLine: 14,
        hunk: '@@ -12,3 +12,3 @@\n+change',
        comment: 'Please simplify this branch.',
      }),
    });
  });

  it('surfaces load and comment failures', async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({}, false, 500));
    await expect(fetchSessionDiff('s1')).rejects.toThrow(/session diff/i);

    fetchMock.mockResolvedValueOnce(jsonRes({}, false, 400));
    await expect(
      postDiffComment('s1', {
        path: 'src/app.ts',
        startLine: 1,
        endLine: 1,
        hunk: '',
        comment: 'Nope',
      }),
    ).rejects.toThrow(/diff comment/i);
  });
});
