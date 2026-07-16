import { describe, expect, it } from 'bun:test';
import { HeartbeatService } from '../../../../src/attention/heartbeat/heartbeat.service';
import type { RaiseSignal } from '../../../../src/attention/attention.types';
import type { LoopAttentionSignal } from '../../../../src/loops/loops.types';

/**
 * The heartbeat binds the loop primitive's attention seam (avoids a
 * loops→attention module cycle) and its wedged-run threshold from settings.
 */
describe('HeartbeatService loop seams', () => {
  function make(settingValue: string | undefined) {
    const raised: RaiseSignal[] = [];
    const loops = {
      raiseAttention: (() => {}) as (s: LoopAttentionSignal) => void,
      maxPendingAgeMs: 999,
    };
    const attention = { raise: (s: RaiseSignal) => { raised.push(s); return s; } };
    const settings = { resolve: (k: string) => (k === 'NUNCIO_LOOP_STUCK_PENDING_AGE_MIN' ? settingValue : undefined) };
    const svc = new HeartbeatService(
      undefined, settings as never, attention as never, loops as never,
    );
    (svc as unknown as { bindLoopSeams: () => void }).bindLoopSeams();
    return { loops, raised };
  }

  it('routes loops.raiseAttention to attention.raise', () => {
    const { loops, raised } = make('180');
    loops.raiseAttention({ kind: 'tripped-breaker', subjectId: 'loop1', title: 'boom' });
    expect(raised).toEqual([{ kind: 'tripped-breaker', subjectId: 'loop1', title: 'boom' }]);
  });

  it('binds maxPendingAgeMs from the setting (minutes → ms)', () => {
    const { loops } = make('45');
    expect(loops.maxPendingAgeMs).toBe(45 * 60_000);
  });

  it('leaves the default threshold when the setting is missing or non-positive', () => {
    expect(make(undefined).loops.maxPendingAgeMs).toBe(999);
    expect(make('0').loops.maxPendingAgeMs).toBe(999);
    expect(make('-5').loops.maxPendingAgeMs).toBe(999);
    expect(make('abc').loops.maxPendingAgeMs).toBe(999);
  });
});
