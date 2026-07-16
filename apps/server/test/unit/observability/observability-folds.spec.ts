import { describe, expect, it } from 'bun:test';
import {
  emptyObservabilityMetrics,
  foldObservabilityRollups,
  foldObservabilitySummary,
  foldSessionObservability,
} from '../../../src/observability/observability-folds';
import type { ObservabilityQuery, ObservabilitySources } from '../../../src/observability/observability.types';
import type { SessionDto, SessionEvent } from '../../../src/sessions/domain/sessions.types';
import type { TaskDto } from '../../../src/tasks/tasks.types';

const HOUR = 60 * 60_000;

function session(overrides: Partial<SessionDto> & { id: string }): SessionDto {
  return {
    id: overrides.id, title: overrides.title ?? overrides.id,
    status: overrides.status ?? 'IDLE',
    provider: overrides.provider ?? 'pi', model: null, modelOptions: null, mode: null, workspace: null,
    prompt: 'do work', preview: null,
    projectPath: overrides.projectPath ?? '/repo/a',
    baseBranch: null, worktreePath: null, branch: null,
    providerThreadId: null, providerActiveTurnId: null, providerState: null,
    cursorBackend: null, cursorChatId: null, forgeProvider: null,
    pullRequestUrl: null, pullRequestNumber: null, pullRequestState: null, forgeStatus: 'none',
    supportsInteraction: false, supportsInterrupt: false, supportsSteerWhileRunning: false,
    supportsImages: false, pendingInput: false,
    createdAt: overrides.createdAt ?? 0,
    updatedAt: overrides.updatedAt ?? 0,
  };
}

function task(overrides: Partial<TaskDto> & { id: string }): TaskDto {
  return {
    id: overrides.id, prompt: 'queued work', status: overrides.status ?? 'DONE',
    provider: overrides.provider ?? 'pi',
    model: null, modelOptions: null,
    projectPath: overrides.projectPath ?? '/repo/a',
    baseBranch: null, useWorktree: true, workspace: null, parentSessionId: null,
    role: 'standalone', cleanupPolicy: null, reviewState: null,
    sessionId: overrides.sessionId ?? null,
    outcome: null, holdUntil: overrides.holdUntil ?? null,
    createdAt: overrides.createdAt ?? 0, updatedAt: overrides.updatedAt ?? 0,
    startedAt: overrides.startedAt ?? null, finishedAt: overrides.finishedAt ?? null,
  };
}

function event(seq: number, type: string, createdAt: number, payload: unknown = {}): SessionEvent {
  return { seq, type, createdAt, payload };
}

function sources(overrides: Partial<ObservabilitySources> = {}): ObservabilitySources {
  return {
    sessions: [],
    eventsBySession: {},
    tasks: [],
    loopRuns: [],
    attentionItems: [],
    digestRuns: [],
    ...overrides,
  };
}

function query(from = 0, to = 10 * HOUR, now = to): ObservabilityQuery {
  return { window: { from, to }, now };
}

describe('observability folds', () => {
  it('empty world yields zeros and honest unknown usage', () => {
    expect(emptyObservabilityMetrics()).toEqual({
      sessions: { total: 0 },
      tasks: { total: 0 },
      turns: { total: 0 },
      steers: { total: 0, human: 0, auto: 0, queued: 0 },
      verify: { total: 0, passed: 0, failed: 0, rate: null },
      loops: { total: 0 },
      attention: { total: 0, open: 0, unacked: 0, resolved: 0 },
      duration: { totalMs: 0, runningMs: 0 },
      usage: {
        inputTokens: null,
        outputTokens: null,
        totalTokens: null,
        costUsd: null,
        source: 'unavailable',
      },
    });
  });

  it('single session counts turns, steers, verify pass rate, and closed duration', () => {
    const s1 = session({ id: 's1', provider: 'cursor', projectPath: '/repo/a' });
    const input = sources({
      sessions: [s1],
      eventsBySession: {
        s1: [
          event(1, 'status', 100, { status: 'RUNNING' }),
          event(2, 'user_message', 110, { text: 'start' }),
          event(3, 'steer_message', 150, { text: 'human steer' }),
          event(4, 'verify_result', 200, { ok: false }),
          event(5, 'verify_retry', 210, { retryId: 'r1' }),
          event(6, 'steer_message', 220, { text: 'auto', origin: 'verify_retry' }),
          event(7, 'verify_result', 300, { ok: true }),
          event(8, 'status', 400, { status: 'IDLE' }),
        ],
      },
    });

    expect(foldSessionObservability(input, 's1', query())).toMatchObject({
      sessionId: 's1',
      provider: 'cursor',
      projectPath: '/repo/a',
      metrics: {
        turns: { total: 3 },
        steers: { total: 2, human: 1, auto: 1, queued: 0 },
        verify: { total: 2, passed: 1, failed: 1, rate: 0.5 },
        duration: { totalMs: 300, runningMs: 0 },
      },
    });
  });

  it('multi-provider/project rollups tolerate unknown provider and unassigned project', () => {
    const input = sources({
      sessions: [
        session({ id: 'pi-1', provider: 'pi', projectPath: '/repo/a' }),
        session({ id: 'mystery-1', provider: 'mystery-sdk', projectPath: null }),
      ],
      tasks: [
        task({ id: 't1', provider: 'pi', projectPath: '/repo/a' }),
        task({ id: 't2', provider: 'mystery-sdk', projectPath: null }),
      ],
      eventsBySession: {
        'pi-1': [event(1, 'user_message', 100)],
        'mystery-1': [event(1, 'user_message', 200)],
      },
    });

    const rollups = foldObservabilityRollups(input, query());
    expect(rollups).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ dimension: 'provider', key: 'pi' }),
        expect.objectContaining({ dimension: 'provider', key: 'mystery-sdk' }),
        expect.objectContaining({ dimension: 'project', key: 'unassigned' }),
      ]),
    );
  });

  it('window boundaries are inclusive from and exclusive to', () => {
    const s1 = session({ id: 's1' });
    const input = sources({
      sessions: [s1],
      eventsBySession: {
        s1: [
          event(1, 'steer_message', 100, { text: 'included' }),
          event(2, 'steer_message', 200, { text: 'excluded' }),
        ],
      },
    });

    expect(foldObservabilitySummary(input, query(100, 200, 200)).steers.total).toBe(1);
  });

  it('restart rebuild is deterministic from the same durable rows', () => {
    const input = sources({
      sessions: [session({ id: 's1' })],
      eventsBySession: { s1: [event(1, 'verify_result', 100, { ok: true })] },
    });

    expect(foldObservabilitySummary(input, query())).toEqual(
      foldObservabilitySummary(input, query()),
    );
  });

  it('open run duration uses injected now', () => {
    const s1 = session({ id: 's1', status: 'RUNNING' });
    const input = sources({
      sessions: [s1],
      eventsBySession: { s1: [event(1, 'status', 100, { status: 'RUNNING' })] },
    });

    expect(foldSessionObservability(input, 's1', query(0, 500, 1_100))).toMatchObject({
      metrics: { duration: { totalMs: 1_000, runningMs: 1_000 } },
    });
  });
});
