import { CrewRevisionConflictError } from '../../../src/crew/domain/crew-errors';
import { CrewRunControlService } from '../../../src/crew/crew-run-control.service';
import { CrewRunnerService } from '../../../src/crew/crew-runner.service';

describe('CrewRunControlService CAS', () => {
  it('allows only the first of two same-revision controls to quiesce and apply', async () => {
    let state = {
      id: 'run-1', taskId: 'task-1', phase: 'BUILD', status: 'RUNNING', outcome: null,
      revision: 4, worktreePath: '/worktree', workspaceHead: 'a'.repeat(40),
    };
    const applyEvent = jest.fn((_id: string, input: { expectedRevision: number; event: { type: string } }) => {
      if (input.expectedRevision !== state.revision) throw new Error('revision conflict');
      state = { ...state, revision: 5, status: 'PAUSED' };
      return state;
    });
    const runs = { findById: () => state, applyEvent };
    const quiesce = jest.fn(async () => {});
    const runner = new CrewRunnerService(
      { closed: false } as never, runs as never, {} as never, {} as never,
      {} as never, {} as never, {} as never,
      { abortVerification: () => Promise.resolve(), shutdown: () => Promise.resolve() } as never,
      { quiesce } as never, {} as never, { setSubmissionSink: () => {} } as never,
      { onTaskFinished: () => () => {}, markCrewExecutionReady: () => {} } as never,
    );
    const controls = new CrewRunControlService(
      runs as never, runner, {} as never, { raise: jest.fn(), clear: jest.fn() } as never,
      { inspectBoundary: async () => ({
        ok: true, exists: true, symlink: false, canonicalPath: '/worktree', branch: null,
        fullHead: 'a'.repeat(40), clean: true, reachable: true, reason: null,
      }) } as never,
    );

    const settled = await Promise.allSettled([
      controls.pause('run-1', 4), controls.cancel('run-1', 4),
    ]);

    expect(settled[0]).toMatchObject({ status: 'fulfilled' });
    expect(settled[1]).toMatchObject({ status: 'rejected', reason: expect.any(CrewRevisionConflictError) });
    expect(quiesce).toHaveBeenCalledTimes(1);
    expect(applyEvent).toHaveBeenCalledTimes(1);
  });
});
