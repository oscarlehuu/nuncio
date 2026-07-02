import { describe, it, expect } from 'vitest';
import { bucketTasks, verifyStatusFromOutcome } from './task-lanes';
import type { Task } from './tasks-api';

function task(over: Partial<Task>): Task {
  return {
    id: Math.random().toString(36).slice(2, 10),
    prompt: 'p',
    status: 'QUEUED',
    provider: null,
    model: null,
    modelOptions: null,
    projectPath: null,
    baseBranch: null,
    useWorktree: false,
    workspace: null,
    sessionId: null,
    outcome: null,
    createdAt: 0,
    updatedAt: 0,
    startedAt: null,
    finishedAt: null,
    ...over,
  };
}

describe('bucketTasks', () => {
  it('routes tasks into queued, running, needs-you, and done lanes', () => {
    const queued = task({ status: 'QUEUED' });
    const running = task({ status: 'RUNNING' });
    const needsYou = task({ status: 'RUNNING', pendingInput: true });
    const done = task({ status: 'DONE' });
    const failed = task({ status: 'FAILED' });
    const cancelled = task({ status: 'CANCELLED' });

    const lanes = bucketTasks([queued, running, needsYou, done, failed, cancelled]);
    expect(lanes.queued.map((t) => t.id)).toEqual([queued.id]);
    expect(lanes.running.map((t) => t.id)).toEqual([running.id]);
    expect(lanes.needsYou.map((t) => t.id)).toEqual([needsYou.id]);
    expect(lanes.done.map((t) => t.id)).toEqual([done.id, failed.id, cancelled.id]);
  });
});

describe('verifyStatusFromOutcome', () => {
  it('maps a verify outcome to a chip status', () => {
    expect(verifyStatusFromOutcome({ verify: { ok: true, exitCode: 0 } })).toEqual({
      state: 'passed',
      exitCode: 0,
    });
    expect(
      verifyStatusFromOutcome({ verify: { ok: false, exitCode: 1, timedOut: false } }),
    ).toMatchObject({ state: 'failed' });
  });

  it('returns null without a verify outcome', () => {
    expect(verifyStatusFromOutcome(null)).toBeNull();
    expect(verifyStatusFromOutcome({ sessionStatus: 'IDLE' })).toBeNull();
  });
});
