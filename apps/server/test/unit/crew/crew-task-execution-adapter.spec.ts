import { CrewTaskExecutionAdapter } from '../../../src/crew/crew-task-execution.adapter';

const input = {
  idempotencyKey: 'runner:build:attempt:9', runId: 'run-1', memberKey: 'builder:primary',
  phase: 'BUILD', prompt: 'Build', provider: 'codex', model: 'sol', workspace: '/worktree',
  runtimePolicy: { filesystem: 'workspace-write', workspaceRoot: '/worktree', network: 'disabled' },
};

describe('CrewTaskExecutionAdapter', () => {
  it('quiesces and cancels a stale active attempt before enqueuing the current revision', async () => {
    const stale = {
      id: 'old-task', executionKind: 'crew-member', crewRunId: 'run-1', crewMemberKey: 'builder:primary',
      crewPhase: 'BUILD', crewAttemptKey: 'runner:build:attempt:7', status: 'RUNNING', sessionId: 'old-session',
    };
    const enqueue = jest.fn(() => ({ id: 'new-task', sessionId: null }));
    const cancelCrewMember = jest.fn(() => ({ ...stale, status: 'CANCELLED' }));
    const quiesceCrewSession = jest.fn(async () => {});
    const service = new CrewTaskExecutionAdapter(
      {
        listInternal: () => [stale], findById: () => stale, enqueue, cancelCrewMember,
      } as never,
      { quiesceCrewSession } as never, {} as never,
    );
    expect(await service.startAttempt(input as never)).toMatchObject({ taskId: 'new-task', continued: false });
    expect(quiesceCrewSession).toHaveBeenCalledWith('old-session');
    expect(cancelCrewMember).toHaveBeenCalledWith('old-task');
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({
      crewAttemptKey: input.idempotencyKey, crewRunId: 'run-1', crewMemberKey: 'builder:primary',
    }));
  });

  it('does not cancel or replace stale attempts when any session does not acknowledge stop', async () => {
    const stale = {
      id: 'old-task', executionKind: 'crew-member', crewRunId: 'run-1', crewMemberKey: 'builder:primary',
      crewPhase: 'BUILD', crewAttemptKey: 'runner:build:attempt:7', status: 'RUNNING', sessionId: 'old-session',
    };
    const enqueue = jest.fn();
    const cancelCrewMember = jest.fn();
    const service = new CrewTaskExecutionAdapter(
      { listInternal: () => [stale], findById: () => stale, enqueue, cancelCrewMember } as never,
      { quiesceCrewSession: jest.fn(async () => { throw new Error('interrupt not acknowledged'); }) } as never,
      {} as never,
    );
    await expect(service.startAttempt(input as never)).rejects.toThrow('interrupt not acknowledged');
    expect(cancelCrewMember).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('does not cancel or replace a stale RUNNING claim before its session attachment settles', async () => {
    const stale = {
      id: 'old-task', executionKind: 'crew-member', crewRunId: 'run-1', crewMemberKey: 'builder:primary',
      crewPhase: 'BUILD', crewAttemptKey: 'runner:build:attempt:7', status: 'RUNNING', sessionId: null,
    };
    const enqueue = jest.fn();
    const cancelCrewMember = jest.fn();
    const service = new CrewTaskExecutionAdapter(
      { listInternal: () => [stale], findById: () => stale, enqueue, cancelCrewMember } as never,
      { quiesceCrewSession: jest.fn(async () => {}) } as never,
      {} as never,
    );
    await expect(service.startAttempt(input as never)).rejects.toThrow('session attachment did not settle');
    expect(cancelCrewMember).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });
});
