import { beforeEach, describe, expect, it } from 'bun:test';
import { BadRequestException } from '@nestjs/common';
import { DispatcherService } from '../../../src/dispatcher/dispatcher.service';
import type { DispatcherProposal, DispatcherRuleSources } from '../../../src/dispatcher/dispatcher-rules';
import type { AttentionItemDto } from '../../../src/attention/attention.types';
import type { CreateTaskDto, TaskDto } from '../../../src/tasks/tasks.types';

const NOW = new Date(2026, 6, 8, 20, 5).getTime();

class FakeAttentionRepository {
  rows: AttentionItemDto[] = [];

  list(status?: AttentionItemDto['status']): AttentionItemDto[] {
    return status ? this.rows.filter((row) => row.status === status) : [...this.rows];
  }

  findById(id: string): AttentionItemDto | null {
    return this.rows.find((row) => row.id === id) ?? null;
  }

  findOpen(kind: string, subjectId: string): AttentionItemDto | null {
    return this.rows.find((row) => row.kind === kind && row.subjectId === subjectId && row.status === 'open') ?? null;
  }

  updatePayload(id: string, payload: Record<string, unknown>, now: number): AttentionItemDto | null {
    const row = this.findById(id);
    if (!row) return null;
    row.payload = payload;
    row.updatedAt = now;
    return row;
  }
}

class FakeAttentionService {
  constructor(private readonly repo: FakeAttentionRepository) {}

  clock = { now: () => NOW };

  raise(input: {
    kind: string;
    subjectId: string;
    projectPath?: string | null;
    title: string;
    payload?: Record<string, unknown> | null;
  }): AttentionItemDto {
    const existing = this.repo.findOpen(input.kind, input.subjectId);
    if (existing) {
      existing.title = input.title;
      existing.projectPath = input.projectPath ?? null;
      existing.payload = input.payload ?? null;
      existing.updatedAt = this.clock.now();
      return existing;
    }
    const row: AttentionItemDto = {
      id: `att-${this.repo.rows.length + 1}`,
      kind: input.kind,
      subjectId: input.subjectId,
      projectPath: input.projectPath ?? null,
        severity: input.kind === 'dispatcher-proposal' ? 2 : 1,
      title: input.title,
      payload: input.payload ?? null,
      status: 'open',
      acknowledgedAt: null,
      suppressReraise: false,
      createdAt: this.clock.now(),
      updatedAt: this.clock.now(),
      resolvedAt: null,
    };
    this.repo.rows.push(row);
    return row;
  }

  resolve(id: string): AttentionItemDto {
    const row = this.repo.findById(id);
    if (!row) throw new Error('not found');
    row.status = 'resolved';
    row.resolvedAt ??= this.clock.now();
    row.updatedAt = this.clock.now();
    return row;
  }
}

class FakeTasksService {
  created: TaskDto[] = [];
  fail = false;

  list(): TaskDto[] {
    return [...this.created].reverse();
  }

  enqueueMany(inputs: CreateTaskDto[]): TaskDto[] {
    if (this.fail) throw new Error('task insert failed');
    return inputs.map((input) => {
      const task = {
        id: `task-${this.created.length + 1}`,
        prompt: input.prompt,
        status: 'QUEUED' as const,
        provider: input.provider ?? null,
        model: input.model ?? null,
        modelOptions: input.modelOptions ?? null,
        projectPath: input.projectPath ?? null,
        baseBranch: input.baseBranch ?? null,
        useWorktree: input.useWorktree ?? false,
        workspace: input.workspace ?? null,
        parentSessionId: input.parentSessionId ?? null,
        role: input.role ?? 'standalone',
        cleanupPolicy: input.cleanupPolicy ?? null,
        reviewState: null,
        sessionId: null,
        outcome: null,
        holdUntil: input.holdUntil ?? null,
        createdAt: NOW,
        updatedAt: NOW,
        startedAt: null,
        finishedAt: null,
      };
      this.created.push(task);
      return task;
    });
  }

  private readonly approvalCorrelations = new Map<string, TaskDto>();

  enqueueApprovalBatch<T>(
    entries: Array<{
      input: CreateTaskDto;
      correlationKey: string;
      existingTaskId?: string;
      reuseCorrelationKey?: string;
    }>,
    correlate: (tasks: TaskDto[]) => T,
  ): { tasks: TaskDto[]; correlated: T } {
    if (this.fail) throw new Error('task insert failed');
    const approved = entries.map((entry) => {
      const correlated = this.approvalCorrelations.get(entry.correlationKey);
      if (correlated) return correlated;
      const reused = entry.reuseCorrelationKey
        ? this.approvalCorrelations.get(entry.reuseCorrelationKey)
        : undefined;
      const existing = entry.existingTaskId
        ? this.created.find((task) => task.id === entry.existingTaskId)
        : undefined;
      const task = reused ?? existing ?? this.enqueueMany([entry.input])[0]!;
      this.approvalCorrelations.set(entry.correlationKey, task);
      return task;
    });
    return { tasks: approved, correlated: correlate(approved) };
  }
}

const proposal = (overrides: Partial<DispatcherProposal> = {}): DispatcherProposal => ({
  subjectKey: overrides.subjectKey ?? 'attention:verify-dead:s1',
  title: overrides.title ?? 'Fix the failing verify in app',
  prompt: overrides.prompt ?? 'Fix the failing verify in app. Source: s1.',
  projectPath: overrides.projectPath ?? '/repo/app',
  engine: overrides.engine ?? 'cursor',
  model: overrides.model ?? 'cursor:test',
  rationale: overrides.rationale ?? 'source: open verify-dead attention item s1',
});

describe('DispatcherService', () => {
  let repo: FakeAttentionRepository;
  let attention: FakeAttentionService;
  let tasks: FakeTasksService;
  let service: DispatcherService;

  beforeEach(() => {
    repo = new FakeAttentionRepository();
    attention = new FakeAttentionService(repo);
    tasks = new FakeTasksService();
    service = new DispatcherService(
      attention as never,
      repo as never,
      tasks as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    );
    service.clock = { now: () => NOW };
  });

  it('draftFromSources creates one dispatcher-proposal item for a non-empty fold', () => {
    const item = service.draftFromSources({
      attentionItems: [
        {
          id: 'a1',
          kind: 'verify-dead',
          subjectId: 's1',
          projectPath: '/repo/app',
          severity: 5,
          title: 'Verify failed after auto-fix rounds',
          payload: { sessionId: 's1' },
          status: 'open',
          acknowledgedAt: null,
          suppressReraise: false,
          createdAt: NOW - 1000,
          updatedAt: NOW - 1000,
          resolvedAt: null,
        },
      ],
      loops: [],
      loopRuns: [],
      sessions: [],
      eventsBySession: {},
      tasks: [],
      projectDefaults: {},
      projectWeights: {},
      now: NOW,
    } satisfies DispatcherRuleSources);

    expect(item).not.toBeNull();
    expect(item).toMatchObject({
      kind: 'dispatcher-proposal',
      subjectId: 'dispatch:2026-07-08',
      severity: 2,
    });
    expect(item!.payload).toMatchObject({
      proposals: [expect.objectContaining({ title: 'Fix the failing verify in app' })],
    });
  });

  it('excludes Crew member sessions from repository-backed dispatcher inputs', () => {
    let rawCalls = 0;
    let userFacingCalls = 0;
    const sessions = {
      list: () => { rawCalls += 1; return [{ id: 'crew', verifyOwner: 'crew' }]; },
      listUserFacing: () => {
        userFacingCalls += 1;
        return [{ id: 'solo', verifyOwner: 'session' }];
      },
    };
    const publicDispatcher = new DispatcherService(
      attention as never, repo as never, tasks as never, undefined, undefined,
      sessions as never, { list: () => [] } as never,
      undefined, undefined, undefined,
    );

    const sources = (publicDispatcher as unknown as {
      collectSources: () => DispatcherRuleSources;
    }).collectSources();
    expect(sources.sessions.map(({ id, verifyOwner }) => ({ id, verifyOwner })))
      .toEqual([{ id: 'solo', verifyOwner: 'session' }]);
    expect(userFacingCalls).toBe(1);
    expect(rawCalls).toBe(0);
  });

  it('draftFromSources returns null and creates no item when there are zero proposals', () => {
    const item = service.draftFromSources({
      attentionItems: [],
      loops: [],
      loopRuns: [],
      sessions: [],
      eventsBySession: {},
      tasks: [],
      projectDefaults: {},
      projectWeights: {},
      now: NOW,
    });
    expect(item).toBeNull();
    expect(repo.rows).toHaveLength(0);
  });

  it('draftFromSources is idempotent for the same local evening subject', () => {
    const sources = {
      attentionItems: [],
      loops: [{ id: 'loop-1', name: 'Nightly', goal: 'g', scheduleId: 's', maxRunsPerDay: 1, maxConsecutiveFailures: 3, stop: null, escalation: 'needs-attention', projectPath: '/repo/app', engine: null, model: null, status: 'broken', createdAt: NOW, updatedAt: NOW }],
      loopRuns: [],
      sessions: [],
      eventsBySession: {},
      tasks: [],
      projectDefaults: {},
      projectWeights: {},
      now: NOW,
    } satisfies DispatcherRuleSources;

    const first = service.draftFromSources(sources);
    const second = service.draftFromSources({
      ...sources,
      loops: [{ ...sources.loops[0]!, name: 'Renamed' }],
    });

    expect(first!.id).toBe(second!.id);
    expect(repo.rows.filter((row) => row.kind === 'dispatcher-proposal')).toHaveLength(1);
    expect(second!.payload).toMatchObject({
      proposals: [expect.objectContaining({ title: 'Resume or investigate Renamed' })],
    });
  });

  it('approve creates queued tasks, resolves the proposal, and records audit payload', () => {
    const item = attention.raise({
      kind: 'dispatcher-proposal',
      subjectId: 'dispatch:2026-07-08',
      title: 'Dispatcher proposal for 2026-07-08',
      payload: { proposals: [proposal(), proposal({ subjectKey: 'loop:loop-1', title: 'Resume loop', prompt: 'Resume loop', engine: undefined, model: undefined })] },
    });

    const result = service.approve(item.id);

    expect(result.taskIds).toEqual(['task-1', 'task-2']);
    expect(tasks.created.map((task) => task.prompt)).toEqual(['Fix the failing verify in app. Source: s1.', 'Resume loop']);
    const approved = repo.findById(item.id)!;
    expect(approved.status).toBe('resolved');
    expect(approved.payload).toMatchObject({ approvedAt: NOW, taskIds: ['task-1', 'task-2'] });
  });

  it('approve is idempotent after taskIds are recorded', () => {
    const item = attention.raise({
      kind: 'dispatcher-proposal',
      subjectId: 'dispatch:2026-07-08',
      title: 'Dispatcher proposal for 2026-07-08',
      payload: { proposals: [proposal()], approvedAt: NOW, taskIds: ['task-9'] },
    });

    expect(service.approve(item.id).taskIds).toEqual(['task-9']);
    expect(service.approve(item.id).taskIds).toEqual(['task-9']);
    expect(tasks.created).toHaveLength(0);
  });

  it('approve recovers existing task ids if a retry happens after task creation but before audit', () => {
    tasks.enqueueMany([{
      prompt: proposal().prompt,
      provider: proposal().engine,
      model: proposal().model,
      projectPath: proposal().projectPath ?? undefined,
    }]);
    const item = attention.raise({
      kind: 'dispatcher-proposal',
      subjectId: 'dispatch:2026-07-08',
      title: 'Dispatcher proposal for 2026-07-08',
      payload: { proposals: [proposal()] },
    });

    expect(service.approve(item.id).taskIds).toEqual(['task-1']);
    expect(tasks.created).toHaveLength(1);
  });

  it('approve does not recover terminal historical tasks for a fresh proposal with the same prompt', () => {
    tasks.enqueueMany([{
      prompt: proposal().prompt,
      provider: proposal().engine,
      model: proposal().model,
      projectPath: proposal().projectPath ?? undefined,
    }]);
    tasks.created[0]!.status = 'DONE';
    tasks.created[0]!.finishedAt = NOW - 24 * 60 * 60_000;
    const item = attention.raise({
      kind: 'dispatcher-proposal',
      subjectId: 'dispatch:2026-07-09',
      title: 'Dispatcher proposal for 2026-07-09',
      payload: { proposals: [proposal()] },
    });

    expect(service.approve(item.id).taskIds).toEqual(['task-2']);
    expect(tasks.created).toHaveLength(2);
    expect(tasks.created.map((task) => task.status)).toEqual(['DONE', 'QUEUED']);
  });

  it('approve leaves the item open without audit when task creation fails', () => {
    const item = attention.raise({
      kind: 'dispatcher-proposal',
      subjectId: 'dispatch:2026-07-08',
      title: 'Dispatcher proposal for 2026-07-08',
      payload: { proposals: [proposal()] },
    });
    tasks.fail = true;

    expect(() => service.approve(item.id)).toThrow('task insert failed');
    expect(repo.findById(item.id)!.status).toBe('open');
    expect(repo.findById(item.id)!.payload).toEqual({ proposals: [proposal()] });
  });

  it('approve rejects non-dispatcher attention rows', () => {
    const item = attention.raise({ kind: 'verify-dead', subjectId: 's1', title: 'Verify dead' });
    expect(() => service.approve(item.id)).toThrow(BadRequestException);
  });
});
