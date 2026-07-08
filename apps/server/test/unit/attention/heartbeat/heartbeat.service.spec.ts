import { beforeEach, describe, expect, it } from 'bun:test';
import { HeartbeatService } from '../../../../src/attention/heartbeat/heartbeat.service';

/**
 * Heartbeat dispatcher (rung 3 sub-phase B) — RED until implemented. Verifies the
 * SAFETY contract: bounded, closed-guarded, double-fire safe, and a throwing layer
 * never escapes into the scheduler scan.
 */
describe('HeartbeatService.dispatch', () => {
  let svc: HeartbeatService;
  let calls: string[];

  beforeEach(() => {
    svc = new HeartbeatService();
    calls = [];
    svc.onInfra = async () => { calls.push('infra'); };
    svc.reconcileAttention = () => { calls.push('reconcile-attention'); };
    svc.reconcileLoops = () => { calls.push('reconcile-loops'); };
    svc.onDigest = async (variant) => { calls.push(`digest:${variant}`); };
    svc.isClosed = () => false;
  });

  it('routes each system job to its layer', async () => {
    await svc.dispatch('infra');
    await svc.dispatch('reconcile');
    await svc.dispatch('digest-morning');
    await svc.dispatch('digest-evening');
    expect(calls).toEqual([
      'infra',
      'reconcile-attention',
      'reconcile-loops',
      'digest:morning',
      'digest:evening',
    ]);
  });

  it('the reconcile layer runs BOTH idempotent passes and NOT schedule rehydrate', async () => {
    // rehydrate() recomputes next_fire_at (boot-only); a hourly re-run would
    // perturb cadence timing. The heartbeat must never call it.
    await svc.dispatch('reconcile');
    expect(calls).toEqual(['reconcile-attention', 'reconcile-loops']);
    expect(calls).not.toContain('rehydrate');
  });

  it('is a no-op when the database is closed (fire during shutdown)', async () => {
    svc.isClosed = () => true;
    await svc.dispatch('infra');
    expect(calls).toEqual([]);
  });

  it('a throwing layer never escapes dispatch (scheduler scan is protected)', async () => {
    svc.onInfra = async () => { throw new Error('probe blew up'); };
    await expect(svc.dispatch('infra')).resolves.toBeUndefined();
  });

  it('double-firing the reconcile layer is safe (idempotent passes, invoked each time)', async () => {
    await svc.dispatch('reconcile');
    await svc.dispatch('reconcile');
    expect(calls.filter((c) => c === 'reconcile-attention')).toHaveLength(2);
  });

  it('a never-resolving layer settles at the timeout so the next fire proceeds', async () => {
    // Without the bounded timeout, a hung layer leaves the schedule inFlight
    // forever → every future fire is skipped as overlap. dispatch must settle.
    svc.layerTimeoutMs = 30;
    svc.onInfra = () => new Promise<void>(() => {}); // never resolves
    const start = Date.now();
    await svc.dispatch('infra'); // must resolve (at the timeout), not hang
    expect(Date.now() - start).toBeLessThan(2_000);

    // The next fire still runs.
    svc.onInfra = async () => { calls.push('infra'); };
    await svc.dispatch('infra');
    expect(calls).toContain('infra');
  });
});
