import { allChildrenSettled, projectMultitaskBoard } from '../../../src/tasks/multitask-board';
import type { TaskStatus } from '../../../src/tasks/tasks.types';

const children = (...statuses: TaskStatus[]) => statuses.map((status) => ({ status }));

describe('projectMultitaskBoard — children × status → board', () => {
  const cases: Array<{
    name: string;
    statuses: TaskStatus[];
    overall: 'coordinating' | 'working' | 'settled';
    working: number;
    settledCount: number;
    failed: number;
  }> = [
    { name: 'no children yet', statuses: [], overall: 'coordinating', working: 0, settledCount: 0, failed: 0 },
    { name: 'all queued', statuses: ['QUEUED', 'QUEUED'], overall: 'working', working: 2, settledCount: 0, failed: 0 },
    { name: 'all running', statuses: ['RUNNING', 'RUNNING'], overall: 'working', working: 2, settledCount: 0, failed: 0 },
    {
      name: 'queued + running + done mix',
      statuses: ['QUEUED', 'RUNNING', 'DONE'],
      overall: 'working',
      working: 2,
      settledCount: 1,
      failed: 0,
    },
    { name: 'all done', statuses: ['DONE', 'DONE'], overall: 'settled', working: 0, settledCount: 2, failed: 0 },
    {
      name: 'one failed among done/cancelled (all terminal) still settles',
      statuses: ['DONE', 'FAILED', 'CANCELLED'],
      overall: 'settled',
      working: 0,
      settledCount: 3,
      failed: 1,
    },
    {
      name: 'one failed while a sibling still runs is working, not sunk',
      statuses: ['FAILED', 'RUNNING'],
      overall: 'working',
      working: 1,
      settledCount: 1,
      failed: 1,
    },
  ];

  for (const testCase of cases) {
    it(testCase.name, () => {
      const board = projectMultitaskBoard(children(...testCase.statuses));
      expect(board.overall).toBe(testCase.overall);
      expect(board.working).toBe(testCase.working);
      expect(board.settledCount).toBe(testCase.settledCount);
      expect(board.failed).toBe(testCase.failed);
      expect(board.total).toBe(testCase.statuses.length);
      // working + settledCount always partitions the children.
      expect(board.working + board.settledCount).toBe(board.total);
    });
  }

  it('counts every status bucket exactly', () => {
    const board = projectMultitaskBoard(
      children('QUEUED', 'RUNNING', 'DONE', 'FAILED', 'CANCELLED'),
    );
    expect(board).toMatchObject({
      total: 5,
      queued: 1,
      running: 1,
      done: 1,
      failed: 1,
      cancelled: 1,
      working: 2,
      settledCount: 3,
      overall: 'working',
    });
  });
});

describe('allChildrenSettled', () => {
  it('is true for no children and for all-terminal children', () => {
    expect(allChildrenSettled([])).toBe(true);
    expect(allChildrenSettled(children('DONE', 'FAILED', 'CANCELLED'))).toBe(true);
  });

  it('is false while any child is queued or running', () => {
    expect(allChildrenSettled(children('DONE', 'RUNNING'))).toBe(false);
    expect(allChildrenSettled(children('QUEUED', 'DONE'))).toBe(false);
  });
});
