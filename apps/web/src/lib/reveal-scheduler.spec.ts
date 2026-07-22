import { describe, expect, it } from 'vitest';
import { RevealScheduler } from './reveal-scheduler';

const MAX_LAG_SEC = 1;

/** Drive the scheduler forward with 16ms frames from `from` to `to` (ms),
 * asserting the per-tick invariants and returning the tick timeline. */
function runTicks(
  s: RevealScheduler,
  from: number,
  to: number,
  step = 16,
): number[] {
  const seen: number[] = [];
  let prev = s.revealed;
  for (let t = from; t <= to; t += step) {
    const before = s.target - s.revealed;
    const eff = s.effectiveCps();
    const r = s.tick(t);
    // Monotonic and never past the buffer.
    expect(r).toBeGreaterThanOrEqual(prev);
    expect(r).toBeLessThanOrEqual(s.target);
    // Catch-up bound: at the current reveal rate the remaining buffer would be
    // cleared within ~maxLag (~1s) — the on-screen text never trails by more.
    // `before` counts whole revealed chars (floored), so allow the <1-char
    // rounding slack against the exact backlog the rate is computed from.
    if (before > 0) {
      expect((before - 1) / eff).toBeLessThanOrEqual(MAX_LAG_SEC + 1e-6);
    }
    prev = r;
    seen.push(r);
  }
  return seen;
}

describe('RevealScheduler', () => {
  it('starts fully revealed at the initial length (mount passthrough)', () => {
    const s = new RevealScheduler(12);
    expect(s.revealed).toBe(12);
    expect(s.target).toBe(12);
    expect(s.done).toBe(true);
  });

  it('reset() snaps revealed and target to a length and clears timing', () => {
    const s = new RevealScheduler(0);
    s.observe(500, 0);
    s.tick(0);
    s.tick(200);
    expect(s.revealed).toBeLessThan(500);
    s.reset(42);
    expect(s.revealed).toBe(42);
    expect(s.target).toBe(42);
    expect(s.done).toBe(true);
  });

  it('flush() reveals the whole buffer instantly (turn end / interrupt / error)', () => {
    const s = new RevealScheduler(0);
    s.observe(300, 0);
    s.tick(0);
    s.tick(100);
    expect(s.done).toBe(false);
    expect(s.flush()).toBe(300);
    expect(s.revealed).toBe(300);
    expect(s.done).toBe(true);
  });

  it('reveals a burst gradually — monotonic, bounded, converged within a few seconds', () => {
    const s = new RevealScheduler(0);
    s.observe(300, 0);
    s.tick(0); // prime the tick clock

    // Half-second in, some but not all of the burst is on screen.
    runTicks(s, 16, 500);
    expect(s.revealed).toBeGreaterThan(0);
    expect(s.revealed).toBeLessThan(300);

    // The bulk lands inside the ~1s lag window.
    runTicks(s, 516, 1000);
    expect(s.revealed).toBeGreaterThanOrEqual(150);

    // And it fully converges (no permanent trailing).
    runTicks(s, 1016, 4000);
    expect(s.revealed).toBe(300);
    expect(s.done).toBe(true);
  });

  it('speeds up to converge when chunks arrive faster than the reveal rate', () => {
    const s = new RevealScheduler(0);
    s.tick(0);
    let target = 0;
    // 2000 chars/sec of inflow (200 chars every 100ms) — far above any floor.
    for (let t = 0; t <= 1000; t += 100) {
      target += 200;
      s.observe(target, t);
      runTicks(s, t + 16, t + 100, 16); // asserts the ~1s catch-up bound throughout
    }
    expect(s.target).toBe(2200);
    expect(s.revealed).toBeGreaterThan(0);
    expect(s.revealed).toBeLessThanOrEqual(2200);

    // Inflow stops → the buffer is fully drained shortly after.
    runTicks(s, 1116, 6000);
    expect(s.revealed).toBe(2200);
    expect(s.done).toBe(true);
  });

  it('tracks recent throughput — faster chunks raise the estimated reveal rate', () => {
    const slow = new RevealScheduler(0);
    const fast = new RevealScheduler(0);
    // Same per-chunk size, delivered at very different cadences.
    for (let i = 1; i <= 5; i++) {
      slow.observe(i * 20, i * 1000); //  20 cps
      fast.observe(i * 20, i * 100); //  200 cps
    }
    expect(fast.cps).toBeGreaterThan(slow.cps);
  });

  it('clamps revealed down when the buffer is replaced by a shorter one', () => {
    const s = new RevealScheduler(0);
    s.observe(400, 0);
    s.flush();
    expect(s.revealed).toBe(400);
    // Re-hydration to a shorter/different message must not reveal past its end.
    s.observe(10, 100);
    expect(s.revealed).toBeLessThanOrEqual(10);
    expect(s.target).toBe(10);
  });
});
