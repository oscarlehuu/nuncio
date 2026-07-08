import { describe, expect, it } from 'bun:test';
import { buildGlobalTimeline } from '../../../src/observability/observability-folds';
import type { ObservabilitySources } from '../../../src/observability/observability.types';
import type { AttentionItemDto } from '../../../src/attention/attention.types';
import type { DigestRunDto } from '../../../src/attention/heartbeat/heartbeat.types';
import type { LoopRunDto } from '../../../src/loops/loops.types';
import type { SessionDto, SessionEvent } from '../../../src/sessions/domain/sessions.types';
import type { TaskDto, TaskStatus } from '../../../src/tasks/tasks.types';

function sources(input: Partial<ObservabilitySources>): ObservabilitySources {
  return { sessions: [], eventsBySession: {}, tasks: [], loopRuns: [], attentionItems: [], digestRuns: [], ...input };
}

function session(overrides: Partial<SessionDto> & { id: string }): SessionDto {
  return {
    id: overrides.id,
    title: overrides.title ?? overrides.id,
    status: overrides.status ?? 'IDLE',
    provider: overrides.provider ?? 'pi',
    model: null,
    modelOptions: null,
    workspace: null,
    prompt: 'p',
    preview: null,
    projectPath: overrides.projectPath ?? '/repo/a',
    baseBranch: null,
    worktreePath: null,
    branch: null,
    providerThreadId: null,
    providerActiveTurnId: null,
    providerState: null,
    cursorBackend: null,
    cursorChatId: null,
    forgeProvider: null,
    pullRequestUrl: overrides.pullRequestUrl ?? null,
    pullRequestNumber: overrides.pullRequestNumber ?? null,
    pullRequestState: overrides.pullRequestState ?? null,
    forgeStatus: overrides.forgeStatus ?? 'none',
    supportsInteraction: false,
    supportsInterrupt: false,
    supportsSteerWhileRunning: false,
    supportsImages: false,
    pendingInput: overrides.pendingInput ?? false,
    createdAt: overrides.createdAt ?? 10,
    updatedAt: overrides.updatedAt ?? overrides.createdAt ?? 10,
  };
}

function task(overrides: Partial<TaskDto> & { id: string; status?: TaskStatus }): TaskDto {
  return {
    id: overrides.id,
    prompt: overrides.prompt ?? 'queued work',
    status: overrides.status ?? 'DONE',
    provider: overrides.provider ?? 'pi',
    model: null,
    modelOptions: null,
    projectPath: overrides.projectPath ?? '/repo/a',
    baseBranch: null,
    useWorktree: true,
    workspace: null,
    parentSessionId: null,
    role: 'standalone',
    cleanupPolicy: null,
    reviewState: null,
    sessionId: overrides.sessionId ?? null,
    outcome: overrides.outcome ?? null,
    holdUntil: overrides.holdUntil ?? null,
    createdAt: overrides.createdAt ?? 20,
    updatedAt: overrides.updatedAt ?? 20,
    startedAt: overrides.startedAt ?? 20,
    finishedAt: overrides.finishedAt ?? 30,
  };
}

function attention(overrides: Partial<AttentionItemDto> & { id: string; createdAt: number }): AttentionItemDto {
  return {
    id: overrides.id,
    kind: overrides.kind ?? 'verify-dead',
    subjectId: overrides.subjectId ?? `session:${overrides.id}`,
    projectPath: overrides.projectPath ?? '/repo/a',
    severity: overrides.severity ?? 5,
    title: overrides.title ?? 'Needs verify help',
    payload: overrides.payload ?? { sessionId: overrides.id },
    status: overrides.status ?? 'open',
    acknowledgedAt: null,
    suppressReraise: false,
    createdAt: overrides.createdAt,
    updatedAt: overrides.updatedAt ?? overrides.createdAt,
    resolvedAt: overrides.resolvedAt ?? null,
  };
}

function loopRun(overrides: Partial<LoopRunDto> & { id: string; createdAt: number }): LoopRunDto {
  return {
    id: overrides.id,
    loopId: overrides.loopId ?? 'loop-1',
    taskId: overrides.taskId ?? 'task-1',
    outcome: overrides.outcome ?? 'failed',
    verify: overrides.verify ?? 'red',
    dayBucket: '2026-07-08',
    createdAt: overrides.createdAt,
  };
}

function digest(slotKey: string, at: number): DigestRunDto {
  return {
    slotKey,
    variant: 'evening',
    sentAt: at,
    windowFrom: 0,
    windowTo: at,
    digest: {
      variant: 'evening',
      windowFrom: 0,
      windowTo: at,
      loops: { runsOk: 0, runsFailed: 1, prsOpened: 0 },
      attention: { raised: 1, resolved: 0, openTopCount: 1 },
      sessions: { completed: 0, needsYou: 1 },
      budget: { runsToday: 1, cap: 24 },
      highlights: [],
      projectLines: [],
    },
  };
}

function event(seq: number, type: string, createdAt: number, payload: unknown = {}): SessionEvent {
  return { seq, type, createdAt, payload };
}

describe('global observability timeline', () => {
  it('merges all durable facts into a newest-first feed', () => {
    const result = buildGlobalTimeline(
      sources({
        sessions: [session({ id: 's1', createdAt: 10 })],
        tasks: [task({ id: 'task-1', status: 'DONE', finishedAt: 20 })],
        loopRuns: [loopRun({ id: 'run-1', createdAt: 30 })],
        attentionItems: [attention({ id: 'a1', createdAt: 40 })],
        digestRuns: [digest('2026-07-08:evening', 50)],
        eventsBySession: {
          s1: [
            event(1, 'status', 60, { status: 'IDLE' }),
            event(2, 'verify_needs_attention', 70, { reason: 'max_rounds' }),
          ],
        },
      }),
      { window: { from: 0, to: 100 }, now: 100 },
    );

    expect(result.map((e) => e.kind)).toEqual([
      'session-needs-you',
      'session-completed',
      'digest-sent',
      'attention-raised',
      'loop-run-settled',
      'task-done',
      'session-started',
    ]);
    expect(result[0]).toMatchObject({ ts: 70, sessionId: 's1', projectPath: '/repo/a' });
  });

  it('uses inclusive-from exclusive-to window boundaries', () => {
    const result = buildGlobalTimeline(
      sources({
        sessions: [
          session({ id: 'included', createdAt: 100 }),
          session({ id: 'excluded', createdAt: 200 }),
        ],
      }),
      { window: { from: 100, to: 200 }, now: 200 },
    );

    expect(result.map((e) => e.sessionId)).toEqual(['included']);
  });

  it('paginates with a stable exclusive before timestamp', () => {
    const input = sources({
      sessions: [
        session({ id: 'old', createdAt: 10 }),
        session({ id: 'middle', createdAt: 20 }),
        session({ id: 'new', createdAt: 30 }),
      ],
    });

    const first = buildGlobalTimeline(input, { window: { from: 0, to: 100 }, now: 100, limit: 2 });
    const second = buildGlobalTimeline(input, {
      window: { from: 0, to: 100 },
      now: 100,
      before: first.at(-1)?.ts,
      limit: 2,
    });

    expect(first.map((e) => e.sessionId)).toEqual(['new', 'middle']);
    expect(second.map((e) => e.sessionId)).toEqual(['old']);
    expect(buildGlobalTimeline(input, { window: { from: 0, to: 100 }, now: 100, limit: 2 })).toEqual(first);
  });

  it('does not skip entries when a page boundary lands inside one timestamp group', () => {
    const input = sources({
      sessions: [
        session({ id: 'tie-0', createdAt: 50 }),
        session({ id: 'tie-1', createdAt: 50 }),
        session({ id: 'tie-2', createdAt: 50 }),
        session({ id: 'tie-3', createdAt: 50 }),
        session({ id: 'tie-4', createdAt: 50 }),
        session({ id: 'older', createdAt: 40 }),
      ],
    });

    const first = buildGlobalTimeline(input, { window: { from: 0, to: 100 }, now: 100, limit: 3 });
    const second = buildGlobalTimeline(input, {
      window: { from: 0, to: 100 },
      now: 100,
      before: first.at(-1)?.ts,
      limit: 3,
    });
    const union = [...first, ...second];

    expect(first.filter((e) => e.ts === 50).map((e) => e.sessionId)).toEqual([
      'tie-0',
      'tie-1',
      'tie-2',
      'tie-3',
      'tie-4',
    ]);
    expect(union.map((e) => e.sessionId).sort()).toEqual(['older', 'tie-0', 'tie-1', 'tie-2', 'tie-3', 'tie-4']);
    expect(new Set(union.map((e) => e.id)).size).toBe(union.length);
  });

  it('timestamps settled loop run facts from the linked task finish time', () => {
    const result = buildGlobalTimeline(
      sources({
        tasks: [task({ id: 'task-1', status: 'DONE', createdAt: 0, startedAt: 0, finishedAt: 5 })],
        loopRuns: [loopRun({ id: 'run-1', outcome: 'ok', verify: 'green', createdAt: 0, taskId: 'task-1' })],
      }),
      { window: { from: 2, to: 9 }, now: 9 },
    );

    expect(result).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'loop-run-settled', id: 'loop-run-settled:run-1', ts: 5, at: 5 }),
      ]),
    );
  });

  it('does not surface transparent loop bookkeeping rows as settled runs', () => {
    const result = buildGlobalTimeline(
      sources({
        loopRuns: [
          loopRun({ id: 'budget', outcome: 'budget-exhausted', verify: 'none', createdAt: 30, taskId: null }),
          loopRun({ id: 'skip', outcome: 'skipped-overlap', verify: 'none', createdAt: 20, taskId: null }),
          loopRun({ id: 'resume', outcome: 'resume', verify: 'none', createdAt: 10, taskId: null }),
        ],
      }),
      { window: { from: 0, to: 100 }, now: 100 },
    );

    expect(result.filter((entry) => entry.kind === 'loop-run-settled')).toEqual([]);
  });

  it('returns an empty feed for an empty window', () => {
    const result = buildGlobalTimeline(
      sources({ sessions: [session({ id: 's1', createdAt: 10 })] }),
      { window: { from: 100, to: 200 }, now: 200 },
    );

    expect(result).toEqual([]);
  });

  it('tolerates unknown event and attention kinds without inventing new event types', () => {
    const result = buildGlobalTimeline(
      sources({
        sessions: [session({ id: 's1', createdAt: 10 })],
        attentionItems: [attention({ id: 'legacy', kind: 'legacy-kind', createdAt: 20 })],
        eventsBySession: { s1: [event(1, 'legacy_event', 30, { ok: true })] },
      }),
      { window: { from: 0, to: 100 }, now: 100 },
    );

    expect(result.map((e) => e.kind)).toEqual(['attention-raised', 'session-started']);
  });

  it('shapes action-specific facts with deep-link ids', () => {
    const result = buildGlobalTimeline(
      sources({
        sessions: [
          session({
            id: 's1',
            createdAt: 10,
            updatedAt: 80,
            pullRequestUrl: 'https://forge.local/pr/1',
            pullRequestNumber: 1,
            pullRequestState: 'open',
          }),
        ],
        tasks: [
          task({ id: 'done', status: 'DONE', finishedAt: 20, sessionId: 's1' }),
          task({ id: 'failed', status: 'FAILED', finishedAt: 30 }),
        ],
        loopRuns: [loopRun({ id: 'run-1', outcome: 'ok', verify: 'green', createdAt: 40 })],
        attentionItems: [
          attention({ id: 'breaker', kind: 'tripped-breaker', subjectId: 'loop-1', createdAt: 50, resolvedAt: 60 }),
          attention({ id: 'plain', kind: 'verify-dead', createdAt: 70, resolvedAt: 75 }),
        ],
      }),
      { window: { from: 0, to: 100 }, now: 100 },
    );

    expect(result).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'pr-opened-detected', sessionId: 's1', prUrl: 'https://forge.local/pr/1' }),
        expect.objectContaining({ kind: 'task-done', taskId: 'done', sessionId: 's1' }),
        expect.objectContaining({ kind: 'task-failed', taskId: 'failed' }),
        expect.objectContaining({ kind: 'loop-run-settled', loopId: 'loop-1', outcome: 'ok', verify: 'green' }),
        expect.objectContaining({ kind: 'breaker-tripped', loopId: 'loop-1', attentionId: 'breaker' }),
        expect.objectContaining({ kind: 'breaker-resumed', loopId: 'loop-1', attentionId: 'breaker' }),
        expect.objectContaining({ kind: 'attention-raised', attentionId: 'plain' }),
        expect.objectContaining({ kind: 'attention-resolved', attentionId: 'plain' }),
      ]),
    );
  });
});
