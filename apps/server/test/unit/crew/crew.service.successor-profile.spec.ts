import { CrewService } from '../../../src/crew/crew.service';
import { CrewNotFoundError } from '../../../src/crew/domain/crew-errors';

const head = 'a'.repeat(40);
const deletedProfileSnapshot = {
  presetId: 'quality' as const,
  sourceProfileId: 'deleted-profile',
  sourceProfileRevision: 4,
  resolvedAt: 1,
  bindings: {
    foreman: { provider: 'claude' as const, model: 'fable', runtimePolicy: 'read-only' as const },
    builder: { provider: 'codex' as const, model: 'sol', runtimePolicy: 'workspace-write' as const },
    reviewer: { provider: 'claude' as const, model: 'opus', runtimePolicy: 'read-only' as const },
  },
  tester: { kind: 'nuncio' as const, runtimePolicy: 'read-only' as const },
  policy: {
    maxVerifyRetries: 2, maxReviewRetries: 2, strictFreshFinalReviewer: true,
    verifyCommand: 'bun test',
  },
};

describe('CrewService successor profile continuity', () => {
  it('re-resolves the prior immutable snapshot when its saved profile was deleted', async () => {
    const prior = {
      id: 'run-1', taskId: 'task-1', status: 'TERMINAL', revision: 9,
      workspaceHead: head, profileSnapshot: deletedProfileSnapshot,
    };
    const task = { id: 'task-1', objective: 'Ship it', projectPath: '/repo', baseBranch: 'main' };
    const resolve = jest.fn(() => ({
      state: 'ready', issues: [], snapshot: deletedProfileSnapshot,
    }));
    const create = jest.fn(async (input: Record<string, unknown>) => ({
      id: 'run-2', taskId: 'task-1', priorRunId: 'run-1', ...input,
    }));
    const service = Object.assign(Object.create(CrewService.prototype), {
      profiles: { findById: () => null },
      tasks: { findById: () => task },
      runs: { findById: () => prior, listByTask: () => [prior] },
      resolver: { resolve },
      catalog: { list: async () => [] },
      verifyCommands: { resolve: () => 'bun test' },
      workspace: { fileExistsAtRevision: async () => false },
      successors: { create },
    }) as CrewService;

    const result = await service.createSuccessor('task-1', {
      priorRunId: 'run-1', expectedRevision: 9, expectedBaseHead: head,
      changeRequest: 'Change the copy', profileId: 'deleted-profile',
    });

    expect(resolve).toHaveBeenCalledWith(expect.objectContaining({
      savedProfile: expect.objectContaining({
        id: 'deleted-profile', revision: 4,
        definition: expect.objectContaining({
          bindings: expect.objectContaining({
            builder: { provider: 'codex', model: 'sol' },
          }),
        }),
      }),
    }));
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      task, prior, changeRequest: 'Change the copy', profileSnapshot: deletedProfileSnapshot,
    }));
    expect(result.run).toMatchObject({ id: 'run-2', priorRunId: 'run-1' });
  });

  it('does not silently replace an explicitly requested missing profile', async () => {
    const prior = {
      id: 'run-1', taskId: 'task-1', status: 'TERMINAL', revision: 9,
      workspaceHead: head, profileSnapshot: deletedProfileSnapshot,
    };
    const service = Object.assign(Object.create(CrewService.prototype), {
      profiles: { findById: () => null },
      tasks: { findById: () => ({ id: 'task-1', projectPath: '/repo' }) },
      runs: { findById: () => prior, listByTask: () => [prior] },
    }) as CrewService;

    await expect(service.createSuccessor('task-1', {
      priorRunId: 'run-1', expectedRevision: 9, expectedBaseHead: head,
      changeRequest: 'Use another profile', profileId: 'missing-replacement',
    })).rejects.toBeInstanceOf(CrewNotFoundError);
  });
});
