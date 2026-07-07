import { TasksController } from '../../../src/tasks/tasks.controller';
import { BadRequestException } from '@nestjs/common';

describe('TasksController', () => {
  it('list delegates to the service', () => {
    const list = jest.fn(() => []);
    const controller = new TasksController({ list } as never);
    expect(controller.list()).toEqual([]);
    expect(list).toHaveBeenCalled();
  });

  it('list can filter by parent session', () => {
    const list = jest.fn(() => []);
    const controller = new TasksController({ list } as never);
    controller.list('parent123');
    expect(list).toHaveBeenCalledWith('parent123');
  });

  it('create trims the prompt and forwards task fields (explicit provider kept)', async () => {
    const enqueue = jest.fn((input) => ({ id: 't1', ...input }));
    const controller = new TasksController({ enqueue } as never);

    await controller.create({
      prompt: '  ship it  ',
      provider: 'pi',
      model: 'pi:model',
      projectPath: '/code/nuncio',
      baseBranch: 'main',
      useWorktree: true,
    });

    // Explicit provider wins routing; the model is kept for the explicit engine.
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: 'ship it',
        provider: 'pi',
        model: 'pi:model',
        projectPath: '/code/nuncio',
        baseBranch: 'main',
        useWorktree: true,
      }),
    );
  });

  it('create returns an error object for a blank prompt', async () => {
    const controller = new TasksController({} as never);
    expect(await controller.create({ prompt: '   ' })).toEqual({ error: 'prompt is required' });
  });

  it('multitask trims prompts and delegates parent session fan-out', () => {
    const startMultitask = jest.fn((input) => ({ parentSessionId: input.parentSessionId, tasks: [] }));
    const controller = new TasksController({ startMultitask } as never);

    expect(
      controller.multitask({
        parentSessionId: 'parent123',
        prompts: ['  write tests  ', ' ', 'update docs'],
        provider: 'codex',
        projectPath: '/code/nuncio',
        useWorktree: false,
      }),
    ).toEqual({ parentSessionId: 'parent123', tasks: [] });

    expect(startMultitask).toHaveBeenCalledWith({
      parentSessionId: 'parent123',
      prompts: ['write tests', 'update docs'],
      provider: 'codex',
      projectPath: '/code/nuncio',
      useWorktree: false,
    });
  });

  it('create forwards a valid contextBrief', async () => {
    const enqueue = jest.fn((input) => ({ id: 't1', ...input }));
    const controller = new TasksController({ enqueue } as never);

    await controller.create({ prompt: 'ship it', contextBrief: { goal: 'do the thing' } });

    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ contextBrief: expect.objectContaining({ goal: 'do the thing' }) }),
    );
  });

  it('create rejects a contextBrief without a goal', async () => {
    const controller = new TasksController({ enqueue: jest.fn() } as never);
    await expect(
      controller.create({ prompt: 'ship it', contextBrief: { constraints: ['x'] } as never }),
    ).rejects.toThrow(BadRequestException);
  });

  it('create rejects a contextBrief over the size limit', async () => {
    const controller = new TasksController({ enqueue: jest.fn() } as never);
    const huge = { goal: 'g', constraints: ['x'.repeat(9000)] };
    await expect(controller.create({ prompt: 'ship it', contextBrief: huge })).rejects.toThrow(
      BadRequestException,
    );
  });

  it('create forwards a valid notifyPolicy', async () => {
    const enqueue = jest.fn((input) => ({ id: 't1', ...input }));
    const controller = new TasksController({ enqueue } as never);
    await controller.create({ prompt: 'ship it', notifyPolicy: 'steer' });
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ notifyPolicy: 'steer' }));
  });

  it('create rejects a notifyPolicy outside the enum', async () => {
    const controller = new TasksController({ enqueue: jest.fn() } as never);
    await expect(
      controller.create({ prompt: 'ship it', notifyPolicy: 'shout' as never }),
    ).rejects.toThrow(BadRequestException);
  });

  it('create rejects a tag outside the routing enum', async () => {
    const controller = new TasksController({ enqueue: jest.fn() } as never);
    await expect(
      controller.create({ prompt: 'ship it', tag: 'nonsense' } as never),
    ).rejects.toThrow(BadRequestException);
  });

  it('create routes a tagged task through the shared resolver (mechanical → cursor)', async () => {
    const enqueue = jest.fn((input) => ({ id: 't1', ...input }));
    const settings = {
      resolve: (key: string) =>
        key === 'NUNCIO_ENGINE_ROUTING'
          ? JSON.stringify({ mechanical: { provider: 'cursor', model: 'cursor:fast' } })
          : undefined,
    };
    const agents = {
      defaultId: async () => 'pi',
      available: async () => [{ id: 'pi' }, { id: 'cursor' }],
    };
    const controller = new TasksController({ enqueue } as never, settings as never, agents as never);

    await controller.create({ prompt: 'do it', tag: 'mechanical' } as never);

    // Same resolveTaskEngine path the enqueue tool uses → routed to cursor, tag persisted.
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'cursor', model: 'cursor:fast', tag: 'mechanical' }),
    );
  });

  it('multitask rejects when no prompts remain', () => {
    const controller = new TasksController({} as never);
    expect(() => controller.multitask({ parentSessionId: 'parent123', prompts: ['  '] })).toThrow(
      BadRequestException,
    );
  });

  it('cancel, retry, review, and delete delegate to the service', () => {
    const cancel = jest.fn(() => ({ id: 't1', status: 'CANCELLED' }));
    const retry = jest.fn(() => ({ id: 't2', status: 'QUEUED' }));
    const markReviewed = jest.fn(() => ({ id: 't1', reviewState: 'reviewed' }));
    const remove = jest.fn();
    const controller = new TasksController({ cancel, retry, markReviewed, delete: remove } as never);

    expect(controller.cancel('t1')).toMatchObject({ status: 'CANCELLED' });
    expect(controller.retry('t1')).toMatchObject({ id: 't2' });
    expect(controller.markReviewed('t1')).toMatchObject({ reviewState: 'reviewed' });
    expect(controller.delete('t1')).toEqual({ ok: true });
    expect(cancel).toHaveBeenCalledWith('t1');
    expect(retry).toHaveBeenCalledWith('t1');
    expect(markReviewed).toHaveBeenCalledWith('t1');
    expect(remove).toHaveBeenCalledWith('t1');
  });
});
