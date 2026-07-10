import { CrewRunControlService } from '../../../src/crew/crew-run-control.service';

describe('CrewRunControlService Attention lifecycle', () => {
  it.each([
    ['clarification', (service: CrewRunControlService) => service.clarification('run-1', 4, 'Use SQLite')],
    ['extra round', (service: CrewRunControlService) => service.extraRound('run-1', 4, 'verify')],
    ['cancel', (service: CrewRunControlService) => service.cancel('run-1', 4)],
  ] as const)('clears a durable Crew blocker after successful %s', async (_name, invoke) => {
    let run = blockedRun();
    const runs = {
      findById: () => run,
      applyEvent: (_id: string, input: { event: { type: string } }) => {
        run = input.event.type === 'cancel_requested'
          ? { ...run, revision: run.revision + 1, phase: 'DONE', status: 'TERMINAL', outcome: 'CANCELLED' }
          : { ...run, revision: run.revision + 1, status: 'QUEUED', blockedReason: null };
        return run;
      },
    };
    const clear = jest.fn();
    const service = new CrewRunControlService(
      runs as never,
      {
        runExclusive: (_id: string, operation: () => Promise<unknown>) => operation(),
        drive: async () => run,
        abortVerification: () => Promise.resolve(),
        quiesceCrewRun: () => Promise.resolve(),
      } as never,
      {} as never,
      { raise: jest.fn(), clear } as never,
    );

    await invoke(service);

    expect(clear).toHaveBeenCalledWith('crew-blocked', 'run-1');
    expect(clear).toHaveBeenCalledTimes(1);
  });

  it('does not clear Attention when the resolving transition fails', async () => {
    const clear = jest.fn();
    const service = new CrewRunControlService(
      { findById: blockedRun, applyEvent: () => { throw new Error('persist failed'); } } as never,
      { runExclusive: (_id: string, operation: () => Promise<unknown>) => operation() } as never,
      {} as never,
      { raise: jest.fn(), clear } as never,
    );

    await expect(service.clarification('run-1', 4, 'Use SQLite')).rejects.toThrow('persist failed');
    expect(clear).not.toHaveBeenCalled();
  });
});

interface MutableRun {
  id: string;
  taskId: string;
  phase: string;
  status: string;
  outcome: string | null;
  revision: number;
  contextRevision: number;
  context: { clarifications: string[] };
  blockedReason: string | null;
}

function blockedRun(): MutableRun {
  return {
    id: 'run-1', taskId: 'task-1', phase: 'PLAN', status: 'BLOCKED_USER', outcome: null,
    revision: 4, contextRevision: 1, context: { clarifications: [] }, blockedReason: 'material_clarification',
  };
}
