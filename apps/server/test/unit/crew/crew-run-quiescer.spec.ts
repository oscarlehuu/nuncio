import { CrewRunQuiescerService } from '../../../src/crew/crew-run-quiescer.service';

describe('CrewRunQuiescerService', () => {
  it('stops the active Builder task/process and releases its writer lease', async () => {
    let task = {
      id: 'task-builder', crewRunId: 'run-1', executionKind: 'crew-member',
      status: 'RUNNING', sessionId: 'builder-session',
    };
    const order: string[] = [];
    const service = new CrewRunQuiescerService(
      {
        listInternal: () => [task],
        findById: () => task,
        cancelCrewMember: () => {
          order.push('cancel-task');
          task = { ...task, status: 'CANCELLED' };
          return task;
        },
      } as never,
      { quiesceCrewSession: async () => { order.push('stop-session'); } } as never,
      { listByRun: () => [{ isCurrent: true, sessionId: 'builder-session' }] } as never,
      {
        get: () => ({ token: 'lease-1' }),
        release: () => { order.push('release-lease'); },
      } as never,
    );

    await service.quiesce('run-1', Promise.resolve());

    expect(order).toEqual(['stop-session', 'cancel-task', 'release-lease']);
  });

  it('does not dispose a durable session already claimed by an active successor run', async () => {
    const activeSuccessor = {
      id: 'task-next', crewRunId: 'run-next', executionKind: 'crew-member',
      status: 'RUNNING', sessionId: 'shared-foreman',
    };
    const quiesceCrewSession = jest.fn(async () => {});
    const service = new CrewRunQuiescerService(
      {
        listInternal: () => [activeSuccessor], findById: () => activeSuccessor,
        cancelCrewMember: jest.fn(),
      } as never,
      { quiesceCrewSession } as never,
      { listByRun: () => [
        { isCurrent: true, sessionId: 'shared-foreman' },
        { isCurrent: true, sessionId: 'old-reviewer' },
      ] } as never,
      { get: () => null } as never,
    );
    await service.quiesce('run-prior', Promise.resolve());
    expect(quiesceCrewSession).not.toHaveBeenCalledWith('shared-foreman');
    expect(quiesceCrewSession).toHaveBeenCalledWith('old-reviewer');
  });

  it('waits for every stop and retains tasks and lease when any member does not acknowledge', async () => {
    const tasks = [
      { id: 'task-a', crewRunId: 'run-1', status: 'RUNNING', sessionId: 'session-a' },
      { id: 'task-b', crewRunId: 'run-1', status: 'RUNNING', sessionId: 'session-b' },
    ];
    let secondAcknowledged = false;
    let verificationAcknowledged = false;
    const quiesceCrewSession = jest.fn(async (sessionId: string) => {
      if (sessionId === 'session-a') throw new Error('interrupt not acknowledged');
      await Promise.resolve();
      secondAcknowledged = true;
    });
    const cancelCrewMember = jest.fn();
    const release = jest.fn();
    const service = new CrewRunQuiescerService(
      { listInternal: () => tasks, findById: (id: string) => tasks.find((task) => task.id === id), cancelCrewMember } as never,
      { quiesceCrewSession } as never,
      { listByRun: () => [] } as never,
      { get: () => ({ token: 'lease-1' }), release } as never,
    );
    const verification = Promise.resolve().then(() => { verificationAcknowledged = true; });
    await expect(service.quiesce('run-1', verification)).rejects.toThrow('interrupt not acknowledged');
    expect(secondAcknowledged).toBe(true);
    expect(verificationAcknowledged).toBe(true);
    expect(cancelCrewMember).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
  });

  it('retains tasks and lease when verifier shutdown fails', async () => {
    const task = { id: 'task-a', crewRunId: 'run-1', status: 'QUEUED', sessionId: null };
    const cancelCrewMember = jest.fn();
    const release = jest.fn();
    const service = new CrewRunQuiescerService(
      { listInternal: () => [task], findById: () => task, cancelCrewMember } as never,
      { quiesceCrewSession: jest.fn(async () => {}) } as never,
      { listByRun: () => [] } as never,
      { get: () => ({ token: 'lease-1' }), release } as never,
    );
    await expect(service.quiesce('run-1', Promise.reject(new Error('verifier still running'))))
      .rejects.toThrow('verifier still running');
    expect(cancelCrewMember).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
  });

  it('retains a RUNNING task and lease while session attachment remains unresolved', async () => {
    const task = { id: 'task-pending', crewRunId: 'run-1', status: 'RUNNING', sessionId: null };
    const cancelCrewMember = jest.fn();
    const release = jest.fn();
    const service = new CrewRunQuiescerService(
      { listInternal: () => [task], findById: () => task, cancelCrewMember } as never,
      { quiesceCrewSession: jest.fn(async () => {}) } as never,
      { listByRun: () => [] } as never,
      { get: () => ({ token: 'lease-1' }), release } as never,
    );
    await expect(service.quiesce('run-1', Promise.resolve()))
      .rejects.toThrow('session attachment did not settle');
    expect(cancelCrewMember).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
  });
});
