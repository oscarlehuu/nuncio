import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchCrewArtifactRange, fetchCrewRun } from './crew-api';
import { configureApiClient } from './http';

const run = {
  id: 'run/1', taskId: 'task-1', phase: 'VERIFY', status: 'RUNNING', outcome: null,
  revision: 4, contextRevision: 2, projectPath: '/repo', workspaceHead: 'head-2',
  profileSnapshot: {},
};

const verifyArtifact = {
  id: 'verify/1', runId: run.id, kind: 'verify-log', sha256: 'a'.repeat(64), byteCount: 42,
  retentionState: 'retained', createdAt: 10, relativeStoragePath: 'private/verify.log',
  metadata: {
    workspaceHead: 'head-2', passed: true, exitCode: 0, durationMs: 120,
    timedOut: false, outputOverflow: false, postBoundaryOk: true,
    command: 'secret verify command', cwd: '/private/repo',
  },
};
const diffArtifact = {
  id: 'diff-1', runId: run.id, kind: 'workspace-diff', sha256: 'b'.repeat(64), byteCount: 21,
  retentionState: 'retained', createdAt: 11, relativeStoragePath: 'private/diff.log',
  metadata: {
    workspaceHead: 'head-2', baseHead: 'base-1', truncated: false,
    uiTouched: true, uiFileCount: 3, uiFiles: ['/private/should-not-leak.tsx'],
    cwd: '/private/repo',
  },
};
const jsonResponse = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: vi.fn().mockResolvedValue(body),
}) as unknown as Response;

describe('Crew artifact transport', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    configureApiClient({ baseUrl: 'https://mac.test', fetchImpl: fetchMock });
  });
  afterEach(() => configureApiClient({
    baseUrl: '', fetchImpl: (...args) => globalThis.fetch(...args),
  }));

  it('strictly parses public metadata and drops malformed or cross-run artifacts', async () => {
    fetchMock.mockResolvedValue(jsonResponse({
      run, members: [], results: [], gates: {},
      artifacts: [
        verifyArtifact,
        diffArtifact,
        { ...diffArtifact, id: 'legacy-diff', createdAt: 12,
          metadata: { workspaceHead: 'head-2', baseHead: 'base-1', truncated: false } },
        { ...verifyArtifact, id: 'wrong-run', runId: 'elsewhere' },
        { ...verifyArtifact, id: 'future-kind', kind: 'future-kind' },
        { ...verifyArtifact, id: 'bad-metadata', metadata: { ...verifyArtifact.metadata, passed: 'yes' } },
        { ...diffArtifact, id: 'bad-ui-metadata',
          metadata: { ...diffArtifact.metadata, uiTouched: 'yes' } },
      ],
    }));

    const detail = await fetchCrewRun(run.id);

    expect(detail.artifacts).toEqual([
      {
        id: 'verify/1', runId: run.id, kind: 'verify-log', sha256: 'a'.repeat(64),
        byteCount: 42, retentionState: 'retained', createdAt: 10,
        metadata: {
          workspaceHead: 'head-2', passed: true, exitCode: 0, durationMs: 120,
          timedOut: false, outputOverflow: false, postBoundaryOk: true,
        },
      },
      {
        id: 'diff-1', runId: run.id, kind: 'workspace-diff', sha256: 'b'.repeat(64),
        byteCount: 21, retentionState: 'retained', createdAt: 11,
        metadata: {
          workspaceHead: 'head-2', baseHead: 'base-1', truncated: false,
          uiTouched: true, uiFileCount: 3,
        },
      },
      {
        id: 'legacy-diff', runId: run.id, kind: 'workspace-diff', sha256: 'b'.repeat(64),
        byteCount: 21, retentionState: 'retained', createdAt: 12,
        metadata: { workspaceHead: 'head-2', baseHead: 'base-1', truncated: false },
      },
    ]);
    expect(JSON.stringify(detail.artifacts)).not.toMatch(/relativeStoragePath|command|cwd|private|uiFiles/);
  });

  it('parses a bounded range without deriving byte progress from JavaScript text length', async () => {
    fetchMock.mockResolvedValue(jsonResponse({
      range: { artifactId: 'verify/1', offset: 0, nextOffset: 4, eof: false, text: '🙂' },
    }));

    await expect(fetchCrewArtifactRange(run.id, 'verify/1', { offset: 0, limit: 4 }))
      .resolves.toEqual({
        artifactId: 'verify/1', offset: 0, nextOffset: 4, eof: false, text: '🙂',
      });
    expect('🙂').toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://mac.test/api/crew-runs/run%2F1/artifacts/verify%2F1?offset=0&limit=4',
    );
  });

  it.each([
    { artifactId: 'wrong', offset: 0, nextOffset: 2, eof: false, text: 'ok' },
    { artifactId: 'verify/1', offset: 1, nextOffset: 2, eof: false, text: 'ok' },
    { artifactId: 'verify/1', offset: 0, nextOffset: 0, eof: false, text: '' },
    { artifactId: 'verify/1', offset: 0, nextOffset: -1, eof: true, text: '' },
    { artifactId: 'verify/1', offset: 0, nextOffset: 5, eof: false, text: 'too far' },
    { artifactId: 'verify/1', offset: 0, nextOffset: 0, eof: true, text: 'impossible' },
    { artifactId: 'verify/1', offset: 0, nextOffset: 2, eof: true, text: '' },
    { artifactId: 'verify/1', offset: 0, nextOffset: 3, eof: false, text: '🙂' },
    { artifactId: 'verify/1', offset: 0, nextOffset: 2, eof: 'no', text: 'ok' },
  ])('rejects malformed range payload %#', async (range) => {
    fetchMock.mockResolvedValue(jsonResponse({ range }));
    await expect(fetchCrewArtifactRange(run.id, 'verify/1', { offset: 0, limit: 4 }))
      .rejects.toThrow(/malformed/i);
  });
});
