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

  it('create trims the prompt and forwards task fields', () => {
    const enqueue = jest.fn((input) => ({ id: 't1', ...input }));
    const controller = new TasksController({ enqueue } as never);

    controller.create({
      prompt: '  ship it  ',
      provider: 'pi',
      model: 'pi:model',
      projectPath: '/code/nuncio',
      baseBranch: 'main',
      useWorktree: true,
    });

    expect(enqueue).toHaveBeenCalledWith({
      prompt: 'ship it',
      provider: 'pi',
      model: 'pi:model',
      projectPath: '/code/nuncio',
      baseBranch: 'main',
      useWorktree: true,
    });
  });

  it('create returns an error object for a blank prompt', () => {
    const controller = new TasksController({} as never);
    expect(controller.create({ prompt: '   ' })).toEqual({ error: 'prompt is required' });
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
