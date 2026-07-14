import { BadRequestException, NotFoundException } from '@nestjs/common';
import { describe, expect, it } from 'bun:test';
import { LoopsController } from '../../../src/loops/loops.controller';
import type { LoopDto } from '../../../src/loops/loops.types';

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

  function controllerFor() {
    const calls: Record<string, unknown[][]> = {};
    const record = (name: string, result: unknown = loop) => (...args: unknown[]) => {
      (calls[name] ??= []).push(args);
      return result;
    };
    const loops = {
      list: record('list', [loop]),
      stats: record('stats', { active: 1 }),
      findById: (id: string) => (id === loop.id ? loop : null),
      create: record('create', loop),
      update: record('update', loop),
      pause: record('pause', loop),
      resume: record('resume', loop),
      fireManual: record('fireManual', { runId: 'run-1' }),
      delete: record('delete'),
      runs: record('runs', [{ id: 'run-1' }]),
      runDetail: record('runDetail', { id: 'run-1', status: 'done' }),
    };
    return { controller: new LoopsController(loops as never), calls, loops };
  }

  it('lists loops and returns aggregate stats', () => {
    const { controller } = controllerFor();
    expect(controller.list()).toEqual({ items: [loop] });
    expect(controller.stats()).toEqual({ active: 1 });
  });

  it('returns a loop by id and 404s when missing', () => {
    const { controller } = controllerFor();
    expect(controller.get('loop-1')).toEqual(loop);
    expect(() => controller.get('missing')).toThrow(NotFoundException);
  });

  it('validates create payloads before delegating', () => {
    const { controller } = controllerFor();
    expect(() => controller.create({ goal: '  ' } as never)).toThrow(BadRequestException);
    expect(() => controller.create({ goal: 'x', schedule: { kind: 'cron' } as never })).toThrow(
      BadRequestException,
    );
    expect(
      controller.create({ goal: 'Nightly', schedule: { kind: 'cron', spec: '0 0 * * *' } }),
    ).toEqual(loop);
  });

  it('updates, pauses, resumes, fires, deletes, and lists runs', () => {
    const { controller, calls } = controllerFor();
    expect(controller.update('loop-1', { goal: 'New goal' })).toEqual(loop);
    expect(calls.update).toEqual([['loop-1', { goal: 'New goal' }]]);

    expect(controller.pause('loop-1')).toEqual(loop);
    expect(controller.resume('loop-1')).toEqual(loop);
    expect(controller.fire('loop-1')).toEqual({ runId: 'run-1' });
    expect(controller.remove('loop-1')).toEqual({ ok: true });
    expect(calls.delete).toEqual([['loop-1']]);

    expect(controller.runs('loop-1')).toEqual({ items: [{ id: 'run-1' }] });
    expect(controller.runDetail('loop-1', 'run-1')).toEqual({ id: 'run-1', status: 'done' });
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
