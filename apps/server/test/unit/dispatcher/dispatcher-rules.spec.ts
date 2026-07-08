import { describe, expect, it } from 'bun:test';
import type { AttentionItemDto } from '../../../src/attention/attention.types';
import {
  DEFAULT_DISPATCHER_PROPOSAL_LIMIT,
  foldDispatcherProposals,
  type DispatcherRuleSources,
} from '../../../src/dispatcher/dispatcher-rules';
import type { LoopDto, LoopRunDto } from '../../../src/loops/loops.types';
import type { SessionDto, SessionEvent } from '../../../src/sessions/domain/sessions.types';
import type { TaskDto } from '../../../src/tasks/tasks.types';

const DAY = 24 * 60 * 60_000;
const HOUR = 60 * 60_000;
const NOW = new Date(2026, 6, 8, 20, 5).getTime();

function attention(overrides: Partial<AttentionItemDto> & { id?: string; kind?: string; subjectId?: string }): AttentionItemDto {
  return {
    id: overrides.id ?? `${overrides.kind ?? 'verify-dead'}-1`,
    kind: overrides.kind ?? 'verify-dead',
    subjectId: overrides.subjectId ?? 's1',
    projectPath: overrides.projectPath ?? '/repo/app',
    severity: overrides.severity ?? 5,
    title: overrides.title ?? 'Verify failed after auto-fix rounds',
    payload: overrides.payload ?? { sessionId: 's1' },
    status: overrides.status ?? 'open',
    acknowledgedAt: overrides.acknowledgedAt ?? null,
    suppressReraise: false,
    createdAt: overrides.createdAt ?? NOW - HOUR,
    updatedAt: overrides.updatedAt ?? NOW - HOUR,
    resolvedAt: overrides.resolvedAt ?? null,
  };
}

function task(overrides: Partial<TaskDto> & { id: string; prompt?: string }): TaskDto {
  return {
    id: overrides.id,
    prompt: overrides.prompt ?? 'ship thing',
    status: overrides.status ?? 'QUEUED',
    provider: overrides.provider ?? null,
    model: overrides.model ?? null,
    modelOptions: overrides.modelOptions ?? null,
    projectPath: overrides.projectPath ?? '/repo/app',
    baseBranch: overrides.baseBranch ?? null,
    useWorktree: overrides.useWorktree ?? false,
    workspace: overrides.workspace ?? null,
    parentSessionId: overrides.parentSessionId ?? null,
    role: overrides.role ?? 'standalone',
    cleanupPolicy: overrides.cleanupPolicy ?? null,
    reviewState: overrides.reviewState ?? null,
    sessionId: overrides.sessionId ?? null,
    outcome: overrides.outcome ?? null,
    holdUntil: overrides.holdUntil ?? null,
    createdAt: overrides.createdAt ?? NOW - HOUR,
    updatedAt: overrides.updatedAt ?? NOW - HOUR,
    startedAt: overrides.startedAt ?? null,
    finishedAt: overrides.finishedAt ?? null,
  };
}

function loop(overrides: Partial<LoopDto> & { id: string; goal?: string }): LoopDto {
  return {
    id: overrides.id,
    name: overrides.name ?? null,
    goal: overrides.goal ?? 'nightly maint',
    scheduleId: overrides.scheduleId ?? `sched-${overrides.id}`,
    maxRunsPerDay: overrides.maxRunsPerDay ?? 24,
    maxConsecutiveFailures: overrides.maxConsecutiveFailures ?? 3,
    stop: overrides.stop ?? null,
    escalation: overrides.escalation ?? 'needs-attention',
    projectPath: overrides.projectPath ?? '/repo/app',
    engine: overrides.engine ?? null,
    model: overrides.model ?? null,
    status: overrides.status ?? 'active',
    createdAt: overrides.createdAt ?? NOW - DAY,
    updatedAt: overrides.updatedAt ?? NOW - HOUR,
  };
}

function loopRun(overrides: Partial<LoopRunDto> & { id: string; loopId: string }): LoopRunDto {
  return {
    id: overrides.id,
    loopId: overrides.loopId,
    taskId: overrides.taskId ?? null,
    outcome: overrides.outcome ?? 'failed',
    verify: overrides.verify ?? 'red',
    dayBucket: overrides.dayBucket ?? '2026-07-07',
    createdAt: overrides.createdAt ?? new Date(2026, 6, 7, 10, 0).getTime(),
  };
}

function session(overrides: Partial<SessionDto> & { id: string }): SessionDto {
  return {
    id: overrides.id,
    title: overrides.title ?? 'Session',
    status: overrides.status ?? 'IDLE',
    provider: overrides.provider ?? 'cursor',
    model: overrides.model ?? null,
    modelOptions: overrides.modelOptions ?? null,
    workspace: overrides.workspace ?? null,
    prompt: overrides.prompt ?? 'fix verify',
    preview: overrides.preview ?? null,
    projectPath: overrides.projectPath ?? '/repo/app',
    baseBranch: overrides.baseBranch ?? null,
    worktreePath: overrides.worktreePath ?? null,
    branch: overrides.branch ?? null,
    providerThreadId: overrides.providerThreadId ?? null,
    providerActiveTurnId: overrides.providerActiveTurnId ?? null,
    providerState: overrides.providerState ?? null,
    cursorBackend: overrides.cursorBackend ?? null,
    cursorChatId: overrides.cursorChatId ?? null,
    supportsInteraction: overrides.supportsInteraction ?? true,
    supportsInterrupt: overrides.supportsInterrupt ?? true,
    supportsSteerWhileRunning: overrides.supportsSteerWhileRunning ?? true,
    supportsImages: overrides.supportsImages ?? false,
    pendingInput: overrides.pendingInput ?? false,
    createdAt: overrides.createdAt ?? NOW - HOUR,
    updatedAt: overrides.updatedAt ?? NOW - HOUR,
  };
}

function event(seq: number, type: string, createdAt: number, payload: unknown): SessionEvent {
  return { seq, type, payload, createdAt };
}

const base = (sources: Partial<DispatcherRuleSources> = {}): DispatcherRuleSources => ({
  attentionItems: [],
  loops: [],
  loopRuns: [],
  sessions: [],
  eventsBySession: {},
  tasks: [],
  projectDefaults: {},
  projectWeights: {},
  now: NOW,
  ...sources,
});

describe('dispatcher deterministic rule folds', () => {
  it('empty world returns no proposals', () => {
    expect(foldDispatcherProposals(base())).toEqual([]);
  });

  it('turns an open unacked verify-dead attention item into a verify-fix proposal', () => {
    const proposals = foldDispatcherProposals(base({ attentionItems: [attention({ kind: 'verify-dead' })] }));
    expect(proposals[0]).toMatchObject({
      title: 'Fix the failing verify in app',
      projectPath: '/repo/app',
      rationale: 'source: open verify-dead attention item s1',
    });
    expect(proposals[0]!.prompt).toContain('Fix the failing verify');
  });

  it('turns a broken loop into a resume-or-investigate proposal with loop engine defaults', () => {
    const proposals = foldDispatcherProposals(base({
      loops: [loop({ id: 'loop-1', name: 'Nightly', status: 'broken', engine: 'codex', model: 'codex:mini' })],
    }));
    expect(proposals[0]).toMatchObject({
      title: 'Resume or investigate Nightly',
      engine: 'codex',
      model: 'codex:mini',
      rationale: 'source: loop loop-1 is broken',
    });
  });

  it('turns a stale pr-review item older than 24h into a review proposal', () => {
    const proposals = foldDispatcherProposals(base({
      attentionItems: [
        attention({
          kind: 'pr-review',
          subjectId: '/repo/app#42',
          severity: 2,
          createdAt: NOW - DAY - HOUR,
          payload: { number: 42, url: 'https://git/pr/42' },
          title: 'PR #42 awaiting review',
        }),
      ],
    }));
    expect(proposals[0]).toMatchObject({
      title: 'Review or merge PR #42',
      rationale: 'source: pr-review item /repo/app#42 open for more than 24h',
    });
  });

  it('turns a session verify-dead window into a proposal when no later green verify exists', () => {
    const proposals = foldDispatcherProposals(base({
      sessions: [session({ id: 's1', projectPath: '/repo/app' })],
      eventsBySession: {
        s1: [
          event(1, 'verify_result', NOW - 2 * HOUR, { ok: false }),
          event(2, 'verify_needs_attention', NOW - HOUR, { reason: 'max_rounds' }),
        ],
      },
    }));
    expect(proposals[0]).toMatchObject({
      title: 'Fix the failing verify in app',
      rationale: 'source: session s1 has verify_needs_attention',
    });
  });

  it('emits exactly one verify-fix proposal when an open verify-dead item already represents the session', () => {
    const proposals = foldDispatcherProposals(base({
      attentionItems: [attention({ kind: 'verify-dead', subjectId: 's1' })],
      sessions: [session({ id: 's1', projectPath: '/repo/app' })],
      eventsBySession: {
        s1: [
          event(1, 'verify_result', NOW - 2 * HOUR, { ok: false }),
          event(2, 'verify_needs_attention', NOW - HOUR, { reason: 'max_rounds' }),
        ],
      },
    }));
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({
      subjectKey: 'session:verify-dead:s1',
      title: 'Fix the failing verify in app',
    });
  });

  it('does not propose a verify-dead session when a later green verify cleared it', () => {
    const proposals = foldDispatcherProposals(base({
      sessions: [session({ id: 's1' })],
      eventsBySession: {
        s1: [
          event(1, 'verify_needs_attention', NOW - HOUR, {}),
          event(2, 'verify_result', NOW - 10, { ok: true }),
        ],
      },
    }));
    expect(proposals).toHaveLength(0);
  });

  it('emits exactly one broken-loop proposal when a tripped-breaker item already represents the loop', () => {
    const proposals = foldDispatcherProposals(base({
      attentionItems: [attention({ kind: 'tripped-breaker', subjectId: 'loop-1', severity: 4 })],
      loops: [loop({ id: 'loop-1', name: 'Nightly', status: 'broken' })],
    }));
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({
      subjectKey: 'loop:broken:loop-1',
      title: 'Resume or investigate Nightly',
    });
  });

  it('turns yesterday all-failed loop runs into an investigation proposal', () => {
    const proposals = foldDispatcherProposals(base({
      loops: [loop({ id: 'loop-1', name: 'Nightly' })],
      loopRuns: [
        loopRun({ id: 'r1', loopId: 'loop-1' }),
        loopRun({ id: 'r2', loopId: 'loop-1' }),
      ],
    }));
    expect(proposals[0]).toMatchObject({
      title: 'Investigate why Nightly failed 2 times',
      rationale: 'source: yesterday loop loop-1 had 2 failed runs and 0 ok runs',
    });
  });

  it('does not add yesterday-failed loop proposals for loops already represented as broken', () => {
    const proposals = foldDispatcherProposals(base({
      loops: [loop({ id: 'loop-1', name: 'Nightly', status: 'broken' })],
      loopRuns: [
        loopRun({ id: 'r1', loopId: 'loop-1' }),
        loopRun({ id: 'r2', loopId: 'loop-1' }),
      ],
    }));
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({
      subjectKey: 'loop:broken:loop-1',
      title: 'Resume or investigate Nightly',
    });
  });

  it('turns yesterday failed standalone tasks into a proposal', () => {
    const proposals = foldDispatcherProposals(base({
      tasks: [task({ id: 't1', prompt: 'sync docs', status: 'FAILED', finishedAt: NOW - 30 * HOUR })],
    }));
    expect(proposals[0]).toMatchObject({
      title: 'Investigate failed task: sync docs',
      rationale: 'source: yesterday failed task t1',
    });
  });

  it('turns queued/running starvation into proposals', () => {
    const proposals = foldDispatcherProposals(base({
      tasks: [
        task({ id: 'queued', prompt: 'queued work', status: 'QUEUED', createdAt: NOW - 6 * HOUR }),
        task({ id: 'running', prompt: 'running work', status: 'RUNNING', startedAt: NOW - 5 * HOUR }),
      ],
    }));
    expect(proposals.map((proposal) => proposal.title)).toEqual([
      'Unblock queued task: queued work',
      'Check running task: running work',
    ]);
  });

  it('dedups against existing open dispatcher proposals and queued/running tasks for the same subject', () => {
    const proposals = foldDispatcherProposals(base({
      attentionItems: [
        attention({
          kind: 'dispatcher-proposal',
          subjectId: 'dispatch:2026-07-08',
          payload: { proposals: [{ subjectKey: 'attention:verify-dead:s1' }] },
        }),
        attention({ kind: 'verify-dead', subjectId: 's1' }),
      ],
      tasks: [
        task({ id: 'already', prompt: 'Fix the failing verify in app', status: 'QUEUED' }),
      ],
    }));
    expect(proposals).toHaveLength(0);
  });

  it('caps proposals to the top attention-ranked five', () => {
    const items = Array.from({ length: 7 }, (_, index) =>
      attention({
        kind: index === 6 ? 'permission' : 'anomaly',
        subjectId: `s${index}`,
        severity: index === 6 ? 7 : 1,
        title: `Item ${index}`,
        createdAt: NOW - index,
      }),
    );
    const proposals = foldDispatcherProposals(base({ attentionItems: items }));
    expect(proposals).toHaveLength(DEFAULT_DISPATCHER_PROPOSAL_LIMIT);
    expect(proposals[0]!.title).toBe('Handle Item 6');
  });
});
