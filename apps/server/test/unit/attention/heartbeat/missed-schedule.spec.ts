import { describe, expect, it } from 'bun:test';
import { HeartbeatService } from '../../../../src/attention/heartbeat/heartbeat.service';
import type { RaiseSignal } from '../../../../src/attention/attention.types';
import type { StaleScheduleSkip } from '../../../../src/scheduler/scheduler.types';

/**
 * Boot missed-schedule visibility: the scheduler silently advances a >24h-stale
 * next-fire; the heartbeat drains those skips and raises a missed-schedule item
 * so the skipped fires are not lost.
 */
describe('HeartbeatService.surfaceMissedSchedules', () => {
  function make(skips: StaleScheduleSkip[], loops?: { findById: (id: string) => { projectPath: string | null } | null }) {
    const raised: RaiseSignal[] = [];
    const scheduler = { drainStaleSkips: () => skips };
    const attention = { raise: (s: RaiseSignal) => { raised.push(s); return s; } };
    const svc = new HeartbeatService(
      scheduler as never, undefined, attention as never, loops as never,
    );
    return { svc, raised };
  }

  const skip = (over: Partial<StaleScheduleSkip> = {}): StaleScheduleSkip => ({
    scheduleId: 'sch1',
    kind: 'cron',
    spec: 'daily@09:30',
    target: { kind: 'system', job: 'infra' },
    previousFireAt: 1_000,
    recomputedFireAt: 5_000,
    ...over,
  });

  it('raises a missed-schedule item per drained stale skip (keyed by schedule id)', () => {
    const { svc, raised } = make([skip()]);
    svc.surfaceMissedSchedules();
    expect(raised).toHaveLength(1);
    expect(raised[0]).toMatchObject({ kind: 'missed-schedule', subjectId: 'sch1' });
    expect(raised[0]!.payload).toMatchObject({ scheduleId: 'sch1', spec: 'daily@09:30', previousFireAt: 1_000 });
    expect(raised[0]!.title).toContain('missed fires while offline');
  });

  it('resolves the loop projectPath for a loop-target schedule (ranking)', () => {
    const loops = { findById: (id: string) => (id === 'loopA' ? { projectPath: '/repo/x' } : null) };
    const { svc, raised } = make([skip({ target: { kind: 'loop', loopId: 'loopA' } })], loops);
    svc.surfaceMissedSchedules();
    expect(raised[0]!.projectPath).toBe('/repo/x');
  });

  it('raises nothing when there are no stale skips', () => {
    const { svc, raised } = make([]);
    svc.surfaceMissedSchedules();
    expect(raised).toHaveLength(0);
  });

  it('surfaces one item per stale schedule', () => {
    const { svc, raised } = make([skip({ scheduleId: 'a' }), skip({ scheduleId: 'b' })]);
    svc.surfaceMissedSchedules();
    expect(raised.map((r) => r.subjectId).sort()).toEqual(['a', 'b']);
  });
});
