import { CrewService } from '../../../src/crew/crew.service';

const frozenHead = 'a'.repeat(40);

describe('CrewService frozen base', () => {
  it('persists the resolved branch and exact SHA before starting worktree creation', async () => {
    const order: string[] = [];
    let persistedRunInput: Record<string, unknown> | undefined;
    const run = { id: 'run-1', baseBranch: 'main', baseHead: frozenHead };
    const service = Object.assign(Object.create(CrewService.prototype), {
      resolveProfile: async () => ({ state: 'ready', snapshot: { policy: {} }, issues: [] }),
      workspace: {
        resolveBase: async () => {
          order.push('resolve-base');
          return { baseBranch: 'main', baseHead: frozenHead };
        },
      },
      database: { transaction: (operation: () => unknown) => operation() },
      tasks: {
        create: (input: Record<string, unknown>) => {
          order.push('persist-task');
          return { id: 'task-1', objective: input.objective, projectPath: input.projectPath,
            baseBranch: input.baseBranch };
        },
      },
      runs: {
        create: (input: Record<string, unknown>) => {
          order.push('persist-run');
          persistedRunInput = input;
          return run;
        },
      },
      runner: {
        start: async () => {
          order.push('start-worktree');
          expect(persistedRunInput).toMatchObject({ baseBranch: 'main', baseHead: frozenHead });
          return run;
        },
      },
    }) as CrewService;

    const created = await service.createTask({
      objective: 'Ship exact base', projectPath: '/repo', baseBranch: 'main', profileId: 'profile-1',
    });

    expect(created.run).toBe(run);
    expect(order).toEqual(['resolve-base', 'persist-task', 'persist-run', 'start-worktree']);
  });
});
