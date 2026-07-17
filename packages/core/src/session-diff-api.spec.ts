import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  countDebugSentinelLines,
  fetchSessionDiff,
  postDiffComment,
  type DiffLine,
  type SessionDiff,
} from './session-diff-api';

function diffOf(lines: DiffLine[], path = 'src/relay.ts'): SessionDiff {
  return {
    files: [
      {
        path,
        oldPath: null,
        status: 'modified',
        additions: lines.filter((l) => l.kind === 'add').length,
        deletions: lines.filter((l) => l.kind === 'del').length,
        hunks: [{ header: '@@', oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines }],
      },
    ],
    truncated: false,
    omittedFiles: 0,
  };
}

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

describe('countDebugSentinelLines', () => {
  it('reports a clean diff with no sentinels', () => {
    const report = countDebugSentinelLines(diffOf([{ kind: 'add', text: 'const x = 1;' }]));
    expect(report).toEqual({ count: 0, files: [] });
  });

  it('counts sentinels in ADDED lines and lists their files', () => {
    const report = countDebugSentinelLines(
      diffOf([
        { kind: 'add', text: 'console.error("pid", pid); // nuncio-debug' },
        { kind: 'add', text: 'const real = fix();' },
      ]),
    );
    expect(report.count).toBe(1);
    expect(report.files).toEqual(['src/relay.ts']);
  });

  it('does NOT count a sentinel that is being REMOVED (the cleanup itself)', () => {
    const report = countDebugSentinelLines(
      diffOf([{ kind: 'del', text: 'console.error("pid", pid); // nuncio-debug' }]),
    );
    expect(report.count).toBe(0);
  });

  it('does NOT count a sentinel on an unchanged context line', () => {
    const report = countDebugSentinelLines(
      diffOf([{ kind: 'context', text: 'someExistingCall(); // nuncio-debug' }]),
    );
    expect(report.count).toBe(0);
  });

  it('tallies across multiple files', () => {
    const report = countDebugSentinelLines({
      files: [
        diffOf([{ kind: 'add', text: 'a; // nuncio-debug' }], 'a.ts').files[0]!,
        diffOf([{ kind: 'add', text: 'b; // nuncio-debug' }], 'b.ts').files[0]!,
      ],
      truncated: false,
      omittedFiles: 0,
    });
    expect(report.count).toBe(2);
    expect(report.files.sort()).toEqual(['a.ts', 'b.ts']);
  });

  it('handles a null/empty diff', () => {
    expect(countDebugSentinelLines(null)).toEqual({ count: 0, files: [] });
    expect(countDebugSentinelLines(undefined)).toEqual({ count: 0, files: [] });
  });
});
