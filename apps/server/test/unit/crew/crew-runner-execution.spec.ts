import { CrewRunnerExecutionService } from '../../../src/crew/crew-runner-execution.service';

const head = 'a'.repeat(40);
const run = {
  id: 'run-1', phase: 'BUILD', status: 'QUEUED', revision: 4, contextRevision: 1,
  projectPath: '/source', baseBranch: 'main', baseHead: head,
  worktreePath: '/worktree', branch: 'nuncio/run',
  workspaceHead: head, context: {}, verifyRetriesUsed: 0, reviewRetriesUsed: 0,
};

describe('CrewRunnerExecutionService', () => {
  it('rejects a changed successor workspace before acquiring a lease or invoking Builder', async () => {
    const ensureMember = jest.fn();
    const acquire = jest.fn();
    const service = new CrewRunnerExecutionService(
      { closed: false } as never, { findById: () => run } as never, {} as never,
      { ensureMember, enqueueAttempt: jest.fn() } as never,
      { get: () => null, acquire } as never, {} as never, {} as never,
      { inspectBoundary: async () => ({
        ok: true, exists: true, symlink: false, reachable: true, clean: true,
        canonicalPath: '/worktree', branch: 'nuncio/run', fullHead: 'b'.repeat(40), reason: null,
      }) } as never,
    );
    await expect(service.startBuilder(run as never)).rejects.toThrow('stale');
    expect(ensureMember).not.toHaveBeenCalled();
    expect(acquire).not.toHaveBeenCalled();
  });

  it('treats sandbox spawn failure as infrastructure without consuming a verify retry', async () => {
    let current = {
      ...run, phase: 'VERIFY', status: 'QUEUED', revision: 6,
      profileSnapshot: { policy: { verifyCommand: 'true' } },
    };
    const applyEvent = jest.fn((_id: string, input: { event: { type: string } }) => {
      if (input.event.type === 'verify_started') current = { ...current, status: 'RUNNING', revision: 7 };
      return current;
    });
    const service = new CrewRunnerExecutionService(
      { closed: false } as never, { findById: () => current, applyEvent } as never, {} as never,
      {} as never, {} as never,
      { verify: async () => ({ spawnError: 'sandbox unavailable' }) } as never, {} as never, {} as never,
    );
    await expect(service.runVerify(current as never)).rejects.toThrow('infrastructure');
    expect(applyEvent).toHaveBeenCalledTimes(1);
    expect(current).toMatchObject({ phase: 'VERIFY', status: 'RUNNING', verifyRetriesUsed: 0 });
  });

  it('returns owner-aborted verification without emitting a failed gate or consuming a retry', async () => {
    let current = {
      ...run, phase: 'VERIFY', status: 'QUEUED', revision: 6,
      profileSnapshot: { policy: { verifyCommand: 'sleep 30' } },
    };
    const applyEvent = jest.fn((_id: string, input: { event: { type: string } }) => {
      if (input.event.type === 'verify_started') current = { ...current, status: 'RUNNING', revision: 7 };
      return current;
    });
    const verify = jest.fn((input: { signal: AbortSignal }) => new Promise((resolve) => {
      input.signal.addEventListener('abort', () => resolve({ aborted: true, spawnError: null }), { once: true });
    }));
    const service = new CrewRunnerExecutionService(
      { closed: false } as never, { findById: () => current, applyEvent } as never, {} as never,
      {} as never, {} as never, { verify } as never, {} as never, {} as never,
    );
    const pending = service.runVerify(current as never);
    await Promise.resolve();
    await service.abortVerification('run-1');
    await expect(pending).resolves.toMatchObject({ status: 'RUNNING', verifyRetriesUsed: 0 });
    expect(applyEvent).toHaveBeenCalledTimes(1);
  });
});
