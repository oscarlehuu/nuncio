import { describe, expect, it } from 'bun:test';
import { buildGlobalTimeline } from '../../../src/observability/observability-folds';
import type { ObservabilitySources } from '../../../src/observability/observability.types';
import type { AttentionItemDto } from '../../../src/attention/attention.types';
import type { DigestRunDto } from '../../../src/attention/heartbeat/heartbeat.types';
import type { LoopRunDto } from '../../../src/loops/loops.types';
import type { SessionDto, SessionEvent } from '../../../src/sessions/domain/sessions.types';
import type { TaskDto } from '../../../src/tasks/tasks.types';

function minimalSources(input: Partial<ObservabilitySources>): ObservabilitySources {
  return {
    sessions: [],
    eventsBySession: {},
    tasks: [],
    loopRuns: [],
    attentionItems: [],
    digestRuns: [],
    ...input,
  };
}

function session(id: string, provider = 'pi', projectPath: string | null = '/repo/a'): SessionDto {
  return {
    id,
    title: id,
    status: 'IDLE',
    provider,
    model: null,
    modelOptions: null,
    workspace: null,
    prompt: 'p',
    preview: null,
    projectPath,
    baseBranch: null,
    worktreePath: null,
    branch: null,
    providerThreadId: null,
    providerActiveTurnId: null,
    providerState: null,
    cursorBackend: null,
    cursorChatId: null,
    forgeProvider: null,
    pullRequestUrl: null,
    pullRequestNumber: null,
    pullRequestState: null,
    forgeStatus: 'none',
    supportsInteraction: false,
    supportsInterrupt: false,
    supportsSteerWhileRunning: false,
    supportsImages: false,
    pendingInput: false,
    createdAt: 10,
    updatedAt: 10,
  };
}

function task(id: string, projectPath = '/repo/a', provider = 'pi'): TaskDto {
  return {
    id,
    prompt: 'p',
    status: 'DONE',
    provider,
    model: null,
    modelOptions: null,
    projectPath,
    baseBranch: null,
    useWorktree: true,
    workspace: null,
    parentSessionId: null,
    role: 'standalone',
    cleanupPolicy: null,
    reviewState: null,
    sessionId: null,
    outcome: null,
    createdAt: 20,
    updatedAt: 20,
    startedAt: 20,
    finishedAt: 30,
  };
}

function attention(id: string, at: number, projectPath = '/repo/a'): AttentionItemDto {
  return {
    id,
    kind: 'verify-dead',
    subjectId: `session:${id}`,
    projectPath,
    severity: 5,
    title: 'Needs verify help',
    payload: { sessionId: id },
    status: 'open',
    acknowledgedAt: null,
    suppressReraise: false,
    createdAt: at,
    updatedAt: at,
    resolvedAt: null,
  };
}

function loopRun(id: string, at: number): LoopRunDto {
  return {
    id,
    loopId: 'loop-1',
    taskId: 'task-1',
    outcome: 'failed',
    verify: 'red',
    dayBucket: '2026-07-08',
    createdAt: at,
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
    },
  };
}

function event(seq: number, type: string, createdAt: number, payload: unknown = {}): SessionEvent {
  return { seq, type, createdAt, payload };
}

describe('global observability timeline', () => {
  it('orders session, task, loop, attention, digest, verify, and steer facts by time', () => {
    const sources = minimalSources({
      sessions: [session('s1')],
      tasks: [task('task-1')],
      loopRuns: [loopRun('run-1', 40)],
      attentionItems: [attention('a1', 50)],
      digestRuns: [digest('2026-07-08:evening', 60)],
      eventsBySession: {
        s1: [
          event(1, 'steer_message', 70, { text: 'please fix' }),
          event(2, 'verify_result', 80, { ok: false }),
        ],
      },
    });

    expect(buildGlobalTimeline(sources, { window: { from: 0, to: 100 }, now: 100 }).map((e) => e.kind))
      .toEqual(['session', 'task', 'loop-run', 'attention', 'digest', 'steer', 'verify']);
  });

  it('filters timeline by provider and project', () => {
    const sources = minimalSources({
      sessions: [
        session('pi-1', 'pi', '/repo/a'),
        session('cursor-1', 'cursor', '/repo/b'),
      ],
      tasks: [
        task('task-a', '/repo/a', 'pi'),
        task('task-b', '/repo/b', 'cursor'),
      ],
    });

    const result = buildGlobalTimeline(sources, {
      window: { from: 0, to: 100 },
      now: 100,
      provider: 'cursor',
      projectPath: '/repo/b',
    });
    expect(result.every((entry) => entry.provider === 'cursor' || entry.provider === null)).toBe(true);
    expect(result.every((entry) => entry.projectPath === '/repo/b' || entry.projectPath === null)).toBe(true);
  });

  it('unknown provider and missing project are tolerated', () => {
    const sources = minimalSources({
      sessions: [session('mystery', 'unknown-provider', null)],
      eventsBySession: { mystery: [event(1, 'user_message', 10, { text: 'hi' })] },
    });

    expect(() =>
      buildGlobalTimeline(sources, { window: { from: 0, to: 100 }, now: 100 }),
    ).not.toThrow();
  });
});
