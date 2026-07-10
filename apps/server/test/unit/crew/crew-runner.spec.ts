import { CrewRunnerBlockerService } from '../../../src/crew/crew-runner-blocker.service';
import { CrewProviderAttemptError } from '../../../src/crew/crew-runner-execution.service';
import { CrewRunnerService } from '../../../src/crew/crew-runner.service';
import type { CrewRunDto } from '../../../src/crew/domain/crew.types';

describe('CrewRunnerService', () => {
  it('awaits an async member enqueue rejection and deterministically blocks on the provider', async () => {
    const harness = runnerHarness({
      execution: { startMember: async () => { throw new CrewProviderAttemptError('provider down'); } },
    });
    const blocked = await harness.runner.drive('run-1');
    expect(blocked).toMatchObject({ status: 'BLOCKED_PROVIDER', blockedReason: 'provider_unavailable' });
    expect(harness.raise).toHaveBeenCalledWith(expect.objectContaining({
      subjectId: 'run-1', payload: expect.objectContaining({ crewTaskId: 'task-1', crewRunId: 'run-1' }),
    }));
  });

  it('awaits an async verifier rejection and enters recoverable user-blocked state', async () => {
    const harness = runnerHarness({
      run: { phase: 'VERIFY' },
      execution: { runVerify: async () => { await Promise.resolve(); throw new Error('verifier crashed'); } },
    });
    await expect(harness.runner.drive('run-1')).resolves.toMatchObject({
      phase: 'VERIFY', status: 'BLOCKED_USER', blockedReason: 'unrecoverable_failure',
    });
  });

  it('contains durable-result acceptance failures and quiesces the live member', async () => {
    const harness = runnerHarness({
      run: { status: 'RUNNING' },
      stageAccept: async () => { throw new Error('stale structured result'); },
    });
    await expect(harness.runner.acceptSubmission({ runId: 'run-1' } as never)).resolves.toMatchObject({
      status: 'BLOCKED_USER',
    });
    expect(harness.quiesce).toHaveBeenCalledWith('run-1', expect.any(Promise));
  });

  it('contains finalizer failures from task settlement instead of leaking a rejected callback', async () => {
    const intent = { memberSessionId: 'member-1', result: { kind: 'builder-intent' } };
    const harness = runnerHarness({
      run: { phase: 'BUILD', status: 'RUNNING' }, results: [intent],
      members: [{ id: 'member-1', memberKey: 'builder:primary', isCurrent: true }],
      finalize: async () => { throw new Error('blocked secret'); },
    });
    await expect(harness.runner.handleTaskFinished({
      executionKind: 'crew-member', crewRunId: 'run-1', crewMemberKey: 'builder:primary',
      crewPhase: 'BUILD', crewAttemptKey: 'runner:build:attempt:1',
    } as never)).resolves.toMatchObject({ status: 'BLOCKED_USER' });
    expect(harness.quiesce).toHaveBeenCalled();
  });

  it('disposes member handles only after the terminal member task settles', async () => {
    const harness = runnerHarness({ run: { phase: 'DONE', status: 'TERMINAL', outcome: 'SUCCEEDED' } });
    expect(harness.quiesce).not.toHaveBeenCalled();
    await harness.runner.handleTaskFinished({
      executionKind: 'crew-member', crewRunId: 'run-1', crewMemberKey: 'foreman:primary',
      crewPhase: 'SYNTHESIZE', crewAttemptKey: 'runner:synthesize:attempt:1', status: 'SUCCEEDED',
    } as never);
    expect(harness.quiesce).toHaveBeenCalledWith('run-1', expect.any(Promise));
    expect(harness.state).toMatchObject({ phase: 'DONE', status: 'TERMINAL', outcome: 'SUCCEEDED' });
  });

  it('keeps synthesis as durable intent until settlement, then quiesces before exposing terminal state', async () => {
    const synthesis = {
      memberSessionId: 'foreman-1', workspaceHead: 'a'.repeat(40),
      result: { kind: 'synthesis', workspaceHead: 'a'.repeat(40) },
    };
    const harness = runnerHarness({
      run: { phase: 'SYNTHESIZE', status: 'RUNNING' }, results: [synthesis],
      members: [{ id: 'foreman-1', memberKey: 'foreman:primary', isCurrent: true }],
      stageResult: { phase: 'DONE', status: 'TERMINAL', outcome: 'SUCCEEDED' },
    });
    const duringTool = await harness.runner.acceptSubmission({
      runId: 'run-1', result: synthesis,
    } as never);
    expect(duringTool).toMatchObject({ phase: 'SYNTHESIZE', status: 'RUNNING' });
    expect(harness.accept).not.toHaveBeenCalled();
    expect(harness.quiesce).not.toHaveBeenCalled();

    const settled = await harness.runner.handleTaskFinished({
      executionKind: 'crew-member', crewRunId: 'run-1', crewMemberKey: 'foreman:primary',
      crewPhase: 'SYNTHESIZE', crewAttemptKey: 'runner:synthesize:attempt:1', status: 'SUCCEEDED',
    } as never);
    expect(settled).toMatchObject({ phase: 'DONE', status: 'TERMINAL', outcome: 'SUCCEEDED' });
    expect(harness.order).toEqual(['quiesce', 'accept']);
  });

  it('ignores boot-interrupted task replay until workspace recovery opens execution', async () => {
    const harness = runnerHarness({ run: { phase: 'BUILD', status: 'RUNNING' } });
    harness.runner.onModuleInit();
    harness.finish({
      executionKind: 'crew-member', crewRunId: 'run-1', crewMemberKey: 'builder:primary',
      crewPhase: 'BUILD', status: 'FAILED', outcome: { reason: 'daemon_restart' },
    });
    await Promise.resolve();
    expect(harness.state).toMatchObject({ phase: 'BUILD', status: 'RUNNING' });
    expect(harness.quiesce).not.toHaveBeenCalled();
    harness.runner.markExecutionReady();
    harness.finish({
      executionKind: 'crew-member', crewRunId: 'run-1', crewMemberKey: 'builder:primary',
      crewPhase: 'BUILD', status: 'FAILED', outcome: { reason: 'daemon_restart' },
    });
    await Promise.resolve();
    expect(harness.state).toMatchObject({ phase: 'BUILD', status: 'RUNNING' });
  });

  it('cancels terminal, orphaned, wrong-role, and stale-revision queued attempts before opening claims', () => {
    const queuedTasks = [
      crewTask('exact', 'run-1', 'builder:primary', 'runner:build:attempt:5', 'current-session'),
      crewTask('stale-revision', 'run-1', 'builder:primary', 'runner:build:attempt:4'),
      crewTask('wrong-role', 'run-1', 'foreman:primary', 'runner:build:attempt:5'),
      crewTask('stale-member', 'run-1', 'builder:primary', 'runner:build:attempt:5', 'old-session'),
      crewTask('terminal', 'terminal-run', 'builder:primary', 'runner:build:attempt:5'),
      crewTask('orphan', 'missing-run', 'builder:primary', 'runner:build:attempt:5'),
    ];
    const terminalRun = {
      id: 'terminal-run', phase: 'DONE', status: 'TERMINAL', outcome: 'CANCELLED', revision: 5,
    } as Partial<CrewRunDto>;
    const harness = runnerHarness({
      run: { phase: 'BUILD', status: 'RUNNING', revision: 5 }, queuedTasks,
      members: [{ id: 'builder-current', memberKey: 'builder:primary', sessionId: 'current-session', isCurrent: true }],
      additionalRuns: { 'terminal-run': terminalRun },
    });

    harness.runner.markExecutionReady();

    expect(harness.cancelledTasks).toEqual([
      'stale-revision', 'wrong-role', 'stale-member', 'terminal', 'orphan',
    ]);
    expect(harness.tasksReady).toHaveBeenCalledTimes(1);
  });

  it('ignores a stale prior-attempt settlement instead of accepting its result for the current attempt', async () => {
    const finalize = jest.fn();
    const harness = runnerHarness({
      run: { phase: 'BUILD', status: 'RUNNING', revision: 5 },
      results: [{ memberSessionId: 'builder-1', result: { kind: 'builder-intent' } }],
      members: [{ id: 'builder-1', memberKey: 'builder:primary', isCurrent: true }], finalize,
    });
    const settled = await harness.runner.handleTaskFinished({
      executionKind: 'crew-member', crewRunId: 'run-1', crewMemberKey: 'builder:primary',
      crewPhase: 'BUILD', crewAttemptKey: 'runner:build:attempt:4', status: 'DONE',
    } as never);
    expect(settled).toMatchObject({ phase: 'BUILD', status: 'RUNNING', revision: 5 });
    expect(finalize).not.toHaveBeenCalled();
  });

  it('does not turn an acknowledged owner cancellation into a provider failure', async () => {
    const harness = runnerHarness({ run: { phase: 'BUILD', status: 'RUNNING' } });
    const settled = await harness.runner.handleTaskFinished({
      executionKind: 'crew-member', crewRunId: 'run-1', crewMemberKey: 'builder:primary',
      crewPhase: 'BUILD', crewAttemptKey: 'runner:build:attempt:1', status: 'CANCELLED',
    } as never);
    expect(settled).toMatchObject({ phase: 'BUILD', status: 'RUNNING' });
    expect(harness.raise).not.toHaveBeenCalled();
  });
});

function runnerHarness(options: {
  run?: Partial<CrewRunDto>;
  execution?: Record<string, unknown>;
  stageAccept?: (notice: unknown) => Promise<unknown>;
  results?: Array<Record<string, unknown>>;
  members?: Array<Record<string, unknown>>;
  finalize?: () => Promise<unknown>;
  stageResult?: Partial<CrewRunDto>;
  queuedTasks?: Array<Record<string, unknown>>;
  additionalRuns?: Record<string, Partial<CrewRunDto>>;
} = {}) {
  let state = {
    id: 'run-1', taskId: 'task-1', priorRunId: null, phase: 'PLAN', status: 'QUEUED', outcome: null,
    blockedReason: null, revision: 1, contextRevision: 0, workspaceHead: 'a'.repeat(40),
    verifyRetriesUsed: 0, reviewRetriesUsed: 0, verifyExtraRounds: 0, reviewExtraRounds: 0,
    profileSnapshot: { policy: { maxVerifyRetries: 2, maxReviewRetries: 2 } }, context: {},
    projectPath: '/repo', baseBranch: 'main', baseHead: 'a'.repeat(40), worktreePath: '/worktree',
    branch: 'nuncio/run', createdAt: 1, updatedAt: 1, ...options.run,
  } as CrewRunDto;
  const runs = {
    findById: (id: string) => id === state.id
      ? state
      : options.additionalRuns?.[id]
        ? { ...state, ...options.additionalRuns[id] } as CrewRunDto
        : null,
    applyEvent: (_id: string, input: { event: { type: string } }) => {
      if (input.event.type === 'provider_unavailable') {
        state = { ...state, revision: state.revision + 1, status: 'BLOCKED_PROVIDER', blockedReason: 'provider_unavailable' };
      } else if (input.event.type === 'recovery_started') {
        state = { ...state, revision: state.revision + 1, status: 'RECOVERING', blockedReason: null };
      } else if (input.event.type === 'recovery_blocked') {
        state = { ...state, revision: state.revision + 1, status: 'BLOCKED_USER', blockedReason: 'unrecoverable_failure' };
      }
      return state;
    },
  };
  const raise = jest.fn();
  const blocker = new CrewRunnerBlockerService(runs as never, { raise, clear: jest.fn() } as never);
  const execution = {
    prepareWorkspace: async () => state,
    startMember: async () => state,
    startBuilder: async () => state,
    runVerify: async () => state,
    startReview: async () => state,
    abortVerification: () => Promise.resolve(), shutdown: () => Promise.resolve(),
    ...options.execution,
  };
  const order: string[] = [];
  const quiesce = jest.fn(async () => { order.push('quiesce'); });
  const accept = jest.fn(options.stageAccept ?? (async () => {
    order.push('accept');
    if (options.stageResult) state = { ...state, ...options.stageResult };
    return state;
  }));
  let finishHandler: (task: never) => void = () => {};
  const cancelledTasks: string[] = [];
  const tasksReady = jest.fn();
  const runner = new CrewRunnerService(
    { closed: false } as never, runs as never,
    {
      findCurrent: () => options.members?.[0] ?? null,
      listByRun: () => options.members ?? [],
    } as never,
    {
      listByRun: () => options.results ?? [],
      findIdempotent: () => options.results?.[0] ?? null,
    } as never,
    { assertCurrent: async () => {} } as never,
    { finalizeSettled: options.finalize ?? (async () => ({})) } as never,
    { accept } as never,
    execution as never, { quiesce } as never, blocker,
    { setSubmissionSink: () => {} } as never,
    {
      onTaskFinished: (handler: (task: never) => void) => { finishHandler = handler; return () => {}; },
      listInternal: () => options.queuedTasks ?? [],
      cancelCrewMember: (id: string) => { cancelledTasks.push(id); return { id, status: 'CANCELLED' }; },
      markCrewQueueReconciled: () => {},
      markCrewExecutionReady: tasksReady,
    } as never,
  );
  return {
    runner, raise, quiesce, accept, order, cancelledTasks, tasksReady,
    finish: (task: Record<string, unknown>) => finishHandler(task as never),
    get state() { return state; },
  };
}

function crewTask(
  id: string, crewRunId: string, crewMemberKey: string, crewAttemptKey: string,
  sessionId: string | null = null,
) {
  return {
    id, executionKind: 'crew-member', status: 'QUEUED', crewRunId, crewMemberKey,
    crewPhase: 'BUILD', crewAttemptKey, sessionId,
  };
}
