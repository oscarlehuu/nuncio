import { CrewRevisionConflictError } from '../../../src/crew/domain/crew-errors';
import { CrewRunControlService } from '../../../src/crew/crew-run-control.service';
import { CrewRunnerService } from '../../../src/crew/crew-runner.service';

const running = {
  id: 'run-1', revision: 4, status: 'RUNNING', outcome: null,
};
interface MutableRun {
  id: string; taskId: string; phase: string; status: string; outcome: string | null;
  revision: number; worktreePath: string; workspaceHead: string; verifyRetriesUsed?: number;
}

const cleanBoundary = {
  ok: true, exists: true, symlink: false, canonicalPath: '/worktree',
  branch: 'nuncio/run', fullHead: 'a'.repeat(40), clean: true, reachable: true, reason: null,
};

function serviceWith(
  quiesceCrewRun: () => Promise<void>,
  findById = () => running,
  boundary = cleanBoundary,
) {
  const applyEvent = jest.fn();
  const runs = { findById, applyEvent };
  const service = new CrewRunControlService(
    runs as never,
    {
      abortVerification: () => Promise.resolve(), quiesceCrewRun,
      runExclusive: (_id: string, operation: () => Promise<unknown>) => operation(),
    } as never,
    {} as never,
    { raise: jest.fn(), clear: jest.fn() } as never,
    { inspectBoundary: async () => boundary } as never,
  );
  return { service, applyEvent };
}

describe('CrewService quiescence barrier', () => {
  it.each(['pause', 'cancel'] as const)('does not expose %s when shutdown is not acknowledged', async (operation) => {
    const { service, applyEvent } = serviceWith(async () => { throw new Error('interrupt not acknowledged'); });
    await expect(service[operation]('run-1', 4)).rejects.toThrow('interrupt not acknowledged');
    expect(applyEvent).not.toHaveBeenCalled();
  });

  it.each(['pause', 'cancel'] as const)('rejects stale %s commands before disrupting the active run', async (operation) => {
    const quiesceCrewRun = jest.fn(async () => {});
    const { service, applyEvent } = serviceWith(quiesceCrewRun);
    await expect(service[operation]('run-1', 3)).rejects.toBeInstanceOf(CrewRevisionConflictError);
    expect(quiesceCrewRun).not.toHaveBeenCalled();
    expect(applyEvent).not.toHaveBeenCalled();
  });

  it.each(['pause', 'cancel'] as const)('preserves the caller CAS revision through serialized %s', async (operation) => {
    const { service, applyEvent } = serviceWith(async () => {});
    applyEvent.mockReturnValue({ ...running, revision: 5 });
    await service[operation]('run-1', 4);
    expect(applyEvent).toHaveBeenCalledWith('run-1', expect.objectContaining({ expectedRevision: 4 }));
  });

  it('durably marks a paused BUILD so the same dirty Builder can resume', async () => {
    const build = {
      ...running, phase: 'BUILD', context: {}, worktreePath: '/worktree', branch: 'nuncio/run',
      workspaceHead: 'a'.repeat(40),
    };
    const { service, applyEvent } = serviceWith(
      async () => {}, () => build, { ...cleanBoundary, clean: false },
    );
    applyEvent.mockReturnValue({ ...build, revision: 5, status: 'PAUSED' });

    await service.pause('run-1', 4);

    expect(applyEvent).toHaveBeenCalledWith('run-1', expect.objectContaining({
      event: { type: 'pause_requested' },
      contextPatch: { resumeDirtyBuild: true },
    }));
  });

  it('does not grant dirty resume when BUILD was clean at the pause boundary', async () => {
    const build = {
      ...running, phase: 'BUILD', context: {}, worktreePath: '/worktree', branch: 'nuncio/run',
      workspaceHead: 'a'.repeat(40),
    };
    const { service, applyEvent } = serviceWith(async () => {}, () => build, cleanBoundary);
    applyEvent.mockReturnValue({ ...build, revision: 5, status: 'PAUSED' });

    await service.pause('run-1', 4);

    expect(applyEvent).toHaveBeenCalledWith('run-1', expect.not.objectContaining({
      contextPatch: expect.anything(),
    }));
  });

  it.each(['pause', 'cancel'] as const)(
    'serializes %s behind deferred Builder enqueue before stopping the task and releasing its lease',
    async (operation) => {
      const entered = deferred();
      const releaseEnqueue = deferred();
      let taskActive = false;
      let leaseHeld = false;
      let startedAfterStop = false;
      let state: MutableRun = {
        ...running, taskId: 'task-1', phase: 'BUILD', status: 'QUEUED', revision: 4,
        worktreePath: '/worktree', workspaceHead: 'a'.repeat(40),
      };
      const runs = {
        findById: () => state,
        applyEvent: (_id: string, input: { expectedRevision: number; event: { type: string } }) => {
          if (input.expectedRevision !== state.revision) throw new Error('revision conflict');
          state = input.event.type === 'pause_requested'
            ? { ...state, revision: state.revision + 1, status: 'PAUSED' }
            : { ...state, revision: state.revision + 1, phase: 'DONE', status: 'TERMINAL', outcome: 'CANCELLED' };
          return state;
        },
      };
      const execution = {
        startBuilder: async () => {
          state = { ...state, revision: 5, status: 'RUNNING' };
          leaseHeld = true;
          entered.resolve();
          await releaseEnqueue.promise;
          startedAfterStop = state.status === 'PAUSED' || state.status === 'TERMINAL' || !leaseHeld;
          taskActive = true;
          return state;
        },
        abortVerification: () => Promise.resolve(), shutdown: () => Promise.resolve(),
      };
      const quiesce = jest.fn(async () => {
        taskActive = false;
        leaseHeld = false;
      });
      const runner = new CrewRunnerService(
        { closed: false } as never, runs as never, { findCurrent: () => null } as never,
        { listByRun: () => [] } as never, {} as never, {} as never, {} as never,
        execution as never, { quiesce } as never, {} as never,
        { setSubmissionSink: () => {} } as never,
        { onTaskFinished: () => () => {}, markCrewExecutionReady: () => {} } as never,
      );
      const service = new CrewRunControlService(
        runs as never, runner, {} as never, { raise: jest.fn(), clear: jest.fn() } as never,
        { inspectBoundary: async () => cleanBoundary } as never,
      );

      const starting = runner.start('run-1');
      await entered.promise;
      const controlling = service[operation]('run-1', 5);
      await Promise.resolve();
      const quiescedBeforeEnqueue = quiesce.mock.calls.length > 0;
      releaseEnqueue.resolve();
      await Promise.all([starting, controlling]);

      expect(quiescedBeforeEnqueue).toBe(false);
      expect(startedAfterStop).toBe(false);
      expect(taskActive).toBe(false);
      expect(leaseHeld).toBe(false);
      expect(state.status).toBe(operation === 'pause' ? 'PAUSED' : 'TERMINAL');
    },
  );

  it.each(['pause', 'cancel'] as const)(
    'aborts delayed VERIFY before queued %s control without consuming a retry',
    async (operation) => {
      const verifyStarted = deferred();
      const verifyStopped = deferred();
      const events: string[] = [];
      let state: MutableRun = {
        ...running, taskId: 'task-1', phase: 'VERIFY', status: 'QUEUED', revision: 4,
        worktreePath: '/worktree', workspaceHead: 'a'.repeat(40), verifyRetriesUsed: 0,
      };
      const runs = {
        findById: () => state,
        applyEvent: (_id: string, input: { expectedRevision: number; event: { type: string } }) => {
          if (input.expectedRevision !== state.revision) throw new Error('revision conflict');
          events.push(input.event.type);
          state = input.event.type === 'pause_requested'
            ? { ...state, revision: 6, status: 'PAUSED' }
            : { ...state, revision: 6, phase: 'DONE', status: 'TERMINAL', outcome: 'CANCELLED' };
          return state;
        },
      };
      const execution = {
        runVerify: async () => {
          state = { ...state, revision: 5, status: 'RUNNING' };
          verifyStarted.resolve();
          await verifyStopped.promise;
          return state;
        },
        abortVerification: () => { verifyStopped.resolve(); return verifyStopped.promise; },
        shutdown: () => Promise.resolve(),
      };
      const quiesce = jest.fn(async () => {});
      const runner = new CrewRunnerService(
        { closed: false } as never, runs as never, { findCurrent: () => null } as never,
        { listByRun: () => [] } as never, {} as never, {} as never, {} as never,
        execution as never, { quiesce } as never, {} as never,
        { setSubmissionSink: () => {} } as never,
        { onTaskFinished: () => () => {}, markCrewExecutionReady: () => {} } as never,
      );
      const service = new CrewRunControlService(
        runs as never, runner, {} as never, { raise: jest.fn(), clear: jest.fn() } as never,
        { inspectBoundary: async () => cleanBoundary } as never,
      );
      const starting = runner.start('run-1');
      await verifyStarted.promise;
      const controlled = service[operation]('run-1', 5);
      await Promise.race([
        controlled,
        new Promise((_, reject) => setTimeout(() => reject(new Error('control deadlocked behind VERIFY')), 1000)),
      ]);
      await starting;
      expect(state).toMatchObject({
        status: operation === 'pause' ? 'PAUSED' : 'TERMINAL', verifyRetriesUsed: 0,
      });
      expect(events).toEqual([operation === 'pause' ? 'pause_requested' : 'cancel_requested']);
      expect(quiesce).toHaveBeenCalledTimes(1);
    },
  );
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
