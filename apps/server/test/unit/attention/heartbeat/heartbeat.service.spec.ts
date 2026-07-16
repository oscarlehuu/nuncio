import { beforeEach, describe, expect, it } from 'bun:test';
import { HeartbeatService } from '../../../../src/attention/heartbeat/heartbeat.service';
import type { HeartbeatHealthOutcome, HeartbeatJob } from '../../../../src/attention/heartbeat/heartbeat.types';

/**
 * Heartbeat dispatcher (rung 3 sub-phase B) — RED until implemented. Verifies the
 * SAFETY contract: bounded, closed-guarded, double-fire safe, and a throwing layer
 * never escapes into the scheduler scan. Also records per-job health.
 */
describe('HeartbeatService.dispatch', () => {
  let svc: HeartbeatService;
  let calls: string[];
  let health: Array<{ job: HeartbeatJob; outcome: HeartbeatHealthOutcome; detail: string | null }>;

  beforeEach(() => {
    svc = new HeartbeatService();
    calls = [];
    health = [];
    svc.onInfra = async () => { calls.push('infra'); };
    svc.reconcileAttention = () => { calls.push('reconcile-attention'); };
    svc.reconcileLoops = () => { calls.push('reconcile-loops'); };
    svc.onDigest = async (variant) => { calls.push(`digest:${variant}`); };
    svc.isClosed = () => false;
    svc.recordHealth = (job, outcome, detail) => { health.push({ job, outcome, detail }); };
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

  describe('health recording (finding: layer errors were swallowed)', () => {
    it('records an ok outcome for each job that succeeds', async () => {
      await svc.dispatch('infra');
      await svc.dispatch('reconcile');
      expect(health).toEqual([
        { job: 'infra', outcome: 'ok', detail: null },
        { job: 'reconcile', outcome: 'ok', detail: null },
      ]);
    });

    it('records an error outcome + detail when a layer throws (not swallowed silently)', async () => {
      svc.onInfra = async () => { throw new Error('probe blew up'); };
      await svc.dispatch('infra');
      expect(health).toEqual([{ job: 'infra', outcome: 'error', detail: 'probe blew up' }]);
    });

    it('records an error when a synchronous reconcile pass throws', async () => {
      svc.reconcileLoops = () => { throw new Error('reconcile boom'); };
      await svc.dispatch('reconcile');
      expect(health).toEqual([{ job: 'reconcile', outcome: 'error', detail: 'reconcile boom' }]);
    });

    it('records a timeout outcome when a layer hangs past the bound', async () => {
      svc.layerTimeoutMs = 20;
      svc.onDigest = () => new Promise<void>(() => {}); // never resolves
      await svc.dispatch('digest-morning');
      expect(health).toHaveLength(1);
      expect(health[0]!.job).toBe('digest-morning');
      expect(health[0]!.outcome).toBe('timeout');
    });

    it('records nothing when the database is closed (fire during shutdown)', async () => {
      svc.isClosed = () => true;
      await svc.dispatch('infra');
      expect(health).toEqual([]);
    });
  });
});
