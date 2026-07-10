import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configureApiClient } from './http';
import {
  CrewApiError,
  commandCrewRun,
  createCrewProfile,
  createCrewSuccessorRun,
  createCrewTask,
  deleteCrewProfile,
  fetchCrewProfile,
  fetchCrewProfiles,
  fetchCrewRun,
  fetchCrewRunEvents,
  fetchCrewRuns,
  fetchCrewTask,
  resolveCrewProfile,
  updateCrewProfile,
  type CrewProfileDto,
  type CrewRunDto,
  type CrewRunSummaryDto,
} from './crew-api';

const binding = (provider: string, model: string) => ({ provider, model });
const profile: CrewProfileDto = {
  id: 'p/1', name: 'Quality', revision: 3, presetId: 'quality',
  definition: {
    bindings: { foreman: binding('claude', 'fable'), builder: binding('codex', 'sol'), reviewer: binding('claude', 'opus') },
    policy: { verifyCommand: 'bun test', maxVerifyRetries: 2, maxReviewRetries: 2, strictFreshFinalReviewer: true },
  },
  createdAt: 1, updatedAt: 2,
};
const snapshot = { ...profile.definition, presetId: 'quality' as const, sourceProfileId: profile.id, sourceProfileRevision: 3, tester: { kind: 'nuncio' as const, runtimePolicy: 'read-only' as const }, resolvedAt: 2 };
const run: CrewRunDto = {
  id: 'r/1', taskId: 't/1', priorRunId: null, phase: 'BUILD', status: 'RUNNING', outcome: null,
  blockedReason: null, profileSnapshot: snapshot, context: {}, contextRevision: 2, revision: 7,
  projectPath: '/repo', baseBranch: 'main', worktreePath: '/work', branch: 'nuncio/crew', workspaceHead: 'a'.repeat(40),
  verifyRetriesUsed: 0, reviewRetriesUsed: 0, maxVerifyRetries: 2, maxReviewRetries: 2,
  verifyExtraRounds: 0, reviewExtraRounds: 0, createdAt: 1, updatedAt: 2,
};
const task = { id: 't/1', objective: 'Ship Crew', projectPath: '/repo', baseBranch: 'main', createdAt: 1, updatedAt: 2 };
const summary: CrewRunSummaryDto = {
  id: run.id, taskId: run.taskId, objective: task.objective, phase: run.phase,
  status: run.status, outcome: run.outcome, blockedReason: run.blockedReason,
  revision: run.revision, workspaceHead: run.workspaceHead,
  createdAt: run.createdAt, updatedAt: run.updatedAt,
};
const jsonResponse = (body: unknown, status = 200) => ({ ok: status >= 200 && status < 300, status, json: vi.fn().mockResolvedValue(body), text: vi.fn().mockResolvedValue(JSON.stringify(body)) }) as unknown as Response;

describe('crew api', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    configureApiClient({ baseUrl: 'https://mac.test', headers: () => ({ Authorization: 'Bearer token' }), fetchImpl: fetchMock });
  });
  afterEach(() => configureApiClient({ baseUrl: '', headers: () => ({}), fetchImpl: (...args) => globalThis.fetch(...args) }));

  it('handles profile CRUD envelopes and URL encoding', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ profiles: [profile] }))
      .mockResolvedValueOnce(jsonResponse({ profile }))
      .mockResolvedValueOnce(jsonResponse({ profile }))
      .mockResolvedValueOnce(jsonResponse({ profile }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    expect(await fetchCrewProfiles()).toEqual([profile]);
    expect(await fetchCrewProfile('p/1')).toEqual(profile);
    await createCrewProfile({ name: profile.name, definition: profile.definition });
    await updateCrewProfile('p/1', { name: profile.name, definition: profile.definition, expectedRevision: 3 });
    await deleteCrewProfile('p/1');
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'https://mac.test/api/crew/profiles',
      'https://mac.test/api/crew/profiles/p%2F1',
      'https://mac.test/api/crew/profiles',
      'https://mac.test/api/crew/profiles/p%2F1',
      'https://mac.test/api/crew/profiles/p%2F1',
    ]);
    expect(fetchMock.mock.calls[2]![1]).toMatchObject({ method: 'POST', headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' } });
    expect(fetchMock.mock.calls[3]![1]).toMatchObject({ method: 'PATCH' });
    expect(fetchMock.mock.calls[4]![1]).toMatchObject({ method: 'DELETE' });
  });

  it('resolves a profile for the selected project', async () => {
    const resolution = { state: 'ready', snapshot, issues: [] };
    fetchMock.mockResolvedValue(jsonResponse({ resolution }));
    await expect(resolveCrewProfile('p/1', '/repo x')).resolves.toEqual(resolution);
    expect(fetchMock).toHaveBeenCalledWith('https://mac.test/api/crew/profiles/p%2F1/resolve', expect.objectContaining({ body: JSON.stringify({ projectPath: '/repo x' }) }));
  });

  it('creates, reads, lists bounded summaries, and creates a successor', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ task, run }))
      .mockResolvedValueOnce(jsonResponse({ task, runs: [run] }))
      .mockResolvedValueOnce(jsonResponse({ runs: [summary] }))
      .mockResolvedValueOnce(jsonResponse({ task, run: { ...run, id: 'r2', priorRunId: run.id } }));
    await createCrewTask({ objective: task.objective, projectPath: '/repo', profileId: 'p/1' });
    await fetchCrewTask('t/1');
    await expect(fetchCrewRuns({ status: 'RUNNING', projectPath: '/repo', limit: 5, offset: 10 }))
      .resolves.toEqual([summary]);
    await createCrewSuccessorRun('t/1', { changeRequest: 'Polish it', expectedBaseHead: run.workspaceHead!, priorRunId: run.id, expectedRevision: run.revision, profileId: 'p/1' });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'https://mac.test/api/crew/tasks',
      'https://mac.test/api/crew/tasks/t%2F1',
      'https://mac.test/api/crew-runs?status=RUNNING&projectPath=%2Frepo&limit=5&offset=10',
      'https://mac.test/api/crew/tasks/t%2F1/runs',
    ]);
  });

  it('normalizes run detail and reads the durable event cursor', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ run, members: [], results: [], artifacts: [], gates: { verify: { retriesUsed: 0, retryLimit: 2, extraRounds: 0 }, review: { retriesUsed: 0, retryLimit: 2, extraRounds: 0 } } }))
      .mockResolvedValueOnce(jsonResponse({ events: [{ runId: run.id, seq: 8, type: 'run_paused', payload: {}, idempotencyKey: 'k', actor: 'user', contextRevision: 2, workspaceHead: run.workspaceHead, createdAt: 3 }], nextSince: 8 }));
    const detail = await fetchCrewRun('r/1');
    expect(detail.members).toEqual([]);
    expect(detail.maxVerifyRetries).toBe(2);
    const events = await fetchCrewRunEvents('r/1', 7, 25);
    expect(events.nextSince).toBe(8);
    expect(fetchMock.mock.calls[1]![0]).toBe('https://mac.test/api/crew-runs/r%2F1/events?since=7&limit=25');
  });

  it.each(['pause', 'resume', 'cancel'] as const)('sends expectedRevision for %s', async (command) => {
    fetchMock.mockResolvedValue(jsonResponse({ run }));
    await commandCrewRun(run.id, command, { expectedRevision: 7 });
    expect(fetchMock).toHaveBeenCalledWith(`https://mac.test/api/crew-runs/r%2F1/${command}`, expect.objectContaining({ method: 'POST', body: JSON.stringify({ expectedRevision: 7 }) }));
  });

  it('sends typed clarification and extra-round commands', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ run }));
    await commandCrewRun(run.id, 'clarification', { expectedRevision: 7, message: 'Use SQLite' });
    await commandCrewRun(run.id, 'extra-round', { expectedRevision: 8, gate: 'verify' });
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toEqual({ expectedRevision: 7, message: 'Use SQLite' });
    expect(JSON.parse(fetchMock.mock.calls[1]![1].body)).toEqual({ expectedRevision: 8, gate: 'verify' });
  });

  it('surfaces a revision conflict with the current projection', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ code: 'CREW_REVISION_CONFLICT', message: 'stale', current: { run } }, 409));
    const failure = commandCrewRun(run.id, 'pause', { expectedRevision: 6 });
    await expect(failure).rejects.toBeInstanceOf(CrewApiError);
    await expect(failure).rejects.toMatchObject({ status: 409, current: run });
  });

  it('fails closed on malformed success payloads', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ profiles: [{ id: 'p1' }] }));
    await expect(fetchCrewProfiles()).rejects.toThrow(/malformed/i);
    fetchMock.mockResolvedValue(jsonResponse({ run: { ...run, phase: 'FUTURE_PHASE' }, members: [], results: [], artifacts: [], gates: {} }));
    await expect(fetchCrewRun(run.id)).rejects.toThrow(/malformed/i);
    fetchMock.mockResolvedValue(jsonResponse({ runs: [{ ...summary, objective: null }] }));
    await expect(fetchCrewRuns({ limit: 5 })).rejects.toThrow(/malformed/i);
  });
});
