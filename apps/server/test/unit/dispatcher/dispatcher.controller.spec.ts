import { describe, expect, it } from 'bun:test';
import { DispatcherController } from '../../../src/dispatcher/dispatcher.controller';

describe('DispatcherController', () => {
  it('POST /dispatcher/draft-now delegates to the dispatcher service', async () => {
    const calls: string[] = [];
    const controller = new DispatcherController({
      async draftNow() {
        calls.push('draft');
        return { id: 'proposal-1' } as never;
      },
      approve() {
        throw new Error('not used');
      },
    } as never);

    await expect(controller.draftNow()).resolves.toEqual({ id: 'proposal-1' } as never);
    expect(calls).toEqual(['draft']);
  });

  it('POST /dispatcher/proposals/:id/approve delegates to approve', () => {
    const controller = new DispatcherController({
      draftNow() {
        throw new Error('not used');
      },
      approve(id: string) {
        return { proposalId: id, taskIds: ['task-1'] };
      },
    } as never);

    expect(controller.approve('proposal-1')).toEqual({ proposalId: 'proposal-1', taskIds: ['task-1'] });
  });
});
