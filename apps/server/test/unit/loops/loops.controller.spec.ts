import { BadRequestException, NotFoundException } from '@nestjs/common';
import { describe, expect, it } from 'bun:test';
import { LoopsController } from '../../../src/loops/loops.controller';
import type { LoopDto, LoopRunDto } from '../../../src/loops/loops.types';
import type { LoopStats } from '../../../src/loops/loop-stats';

describe('LoopsController', () => {
  const loop: LoopDto = {
    id: 'loop-1',
    name: null,
    goal: 'Ship nightly',
    scheduleId: 'sched-1',
    schedule: { kind: 'cron', spec: '0 0 * * *' },
    maxRunsPerDay: 1,
    maxConsecutiveFailures: 3,
    stop: null,
    escalation: 'needs-attention',
    projectPath: null,
    engine: null,
    model: null,
    status: 'active',
    createdAt: 1,
    updatedAt: 1,
  };

  const loopRun: LoopRunDto = {
    id: 'run-1',
    loopId: 'loop-1',
    taskId: 'task-1',
    outcome: 'ok',
    verify: 'green',
    dayBucket: '2024-01-01',
    createdAt: 1,
  };

  const stats: LoopStats = {
    total: 1,
    active: 1,
    broken: 0,
    successful7d: 1,
    failed7d: 0,
    successful24h: 1,
    failed24h: 0,
    sparkline: [],
  };

  function controllerFor() {
    const calls: Record<string, unknown[][]> = {};
    const recordSync = (name: string, result: unknown) => (...args: unknown[]) => {
      (calls[name] ??= []).push(args);
      return result;
    };
    const recordAsync = (name: string, result: unknown) => (...args: unknown[]) => {
      (calls[name] ??= []).push(args);
      return Promise.resolve(result);
    };
    const loops = {
      list: recordSync('list', [loop]),
      stats: recordSync('stats', stats),
      findById: (id: string) => (id === loop.id ? loop : null),
      create: recordAsync('create', loop),
      update: recordAsync('update', loop),
      pause: recordSync('pause', loop),
      resume: recordSync('resume', loop),
      fireManual: recordSync('fireManual', loopRun),
      delete: recordSync('delete', undefined),
      runs: recordSync('runs', [loopRun]),
      runDetail: recordSync('runDetail', { ...loopRun, sessionId: null, durationMs: null, verifyOutputTail: null, failureReason: null, startedAt: null, settledAt: null }),
    };
    return { controller: new LoopsController(loops as never), calls, loops };
  }

  it('lists loops and returns aggregate stats', () => {
    const { controller } = controllerFor();
    expect(controller.list()).toEqual({ items: [loop] });
    expect(controller.stats()).toEqual(stats);
  });

  it('returns a loop by id and 404s when missing', () => {
    const { controller } = controllerFor();
    expect(controller.get('loop-1')).toEqual(loop);
    expect(() => controller.get('missing')).toThrow(NotFoundException);
  });

  it('validates create payloads before delegating', async () => {
    const { controller } = controllerFor();
    expect(() => controller.create({ goal: '  ' } as never)).toThrow(BadRequestException);
    expect(() => controller.create({ goal: 'x', schedule: { kind: 'cron' } as never })).toThrow(
      BadRequestException,
    );
    await expect(
      controller.create({ goal: 'Nightly', schedule: { kind: 'cron', spec: '0 0 * * *' } }),
    ).resolves.toEqual(loop);
  });

  it('updates, pauses, resumes, fires, deletes, and lists runs', async () => {
    const { controller, calls } = controllerFor();
    await expect(controller.update('loop-1', { goal: 'New goal' })).resolves.toEqual(loop);
    expect(calls.update).toEqual([['loop-1', { goal: 'New goal' }]]);

    expect(controller.pause('loop-1')).toEqual(loop);
    expect(controller.resume('loop-1')).toEqual(loop);
    expect(controller.fire('loop-1')).toEqual(loopRun);
    expect(controller.remove('loop-1')).toEqual({ ok: true });
    expect(calls.delete).toEqual([['loop-1']]);

    expect(controller.runs('loop-1')).toEqual({ items: [loopRun] });
    expect(controller.runDetail('loop-1', 'run-1')).toMatchObject({ id: 'run-1', outcome: 'ok' });
  });

  it('404s lifecycle and run routes for unknown loops', () => {
    const { controller } = controllerFor();
    expect(() => controller.pause('missing')).toThrow(NotFoundException);
    expect(() => controller.resume('missing')).toThrow(NotFoundException);
    expect(() => controller.remove('missing')).toThrow(NotFoundException);
    expect(() => controller.runs('missing')).toThrow(NotFoundException);
    expect(() => controller.runDetail('missing', 'run-1')).toThrow(NotFoundException);
  });
});
