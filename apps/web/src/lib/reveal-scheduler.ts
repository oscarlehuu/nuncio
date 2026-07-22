/**
 * Adaptive character-reveal scheduler for streamed assistant text.
 *
 * The provider stream arrives in coarse ~500ms batches; rendering each batch at
 * once reads as lumpy. This scheduler buffers the durable text and reveals it
 * character-by-character at a rate estimated from recent chunk arrivals (an EMA
 * of chars/second), speeding up so the on-screen text never trails the buffer
 * by more than ~1 second of reveal time. It is a pure, timestamp-driven object
 * (no timers, no DOM) so the policy can be unit-tested deterministically; the
 * React hook (`use-revealed-text`) owns the animation-frame loop.
 */
export interface RevealSchedulerOptions {
  /** Max time (ms) the on-screen text may trail the buffer at the current rate. */
  maxLagMs?: number;
  /** Floor reveal speed (chars/sec) so tiny tails still trickle out smoothly. */
  minCps?: number;
  /** EMA smoothing for the chars/sec estimate (0..1; higher = more reactive). */
  emaAlpha?: number;
}

const DEFAULTS = { maxLagMs: 1000, minCps: 60, emaAlpha: 0.4 } as const;

export class RevealScheduler {
  private revealedExact: number;
  private targetLen: number;
  private cpsEma: number;
  private lastChunkAt: number | null = null;
  private lastTickAt: number | null = null;
  private readonly maxLagMs: number;
  private readonly minCps: number;
  private readonly emaAlpha: number;

  constructor(initialRevealed = 0, opts: RevealSchedulerOptions = {}) {
    this.maxLagMs = opts.maxLagMs ?? DEFAULTS.maxLagMs;
    this.minCps = opts.minCps ?? DEFAULTS.minCps;
    this.emaAlpha = opts.emaAlpha ?? DEFAULTS.emaAlpha;
    this.revealedExact = Math.max(0, initialRevealed);
    this.targetLen = this.revealedExact;
    this.cpsEma = this.minCps;
  }

  /** Characters currently revealed (integer). */
  get revealed(): number {
    return Math.floor(this.revealedExact);
  }

  /** Length of the durable buffer. */
  get target(): number {
    return this.targetLen;
  }

  /** Current estimated throughput (chars/sec) from recent chunk arrivals. */
  get cps(): number {
    return this.cpsEma;
  }

  /** True once the on-screen text has caught up to the buffer. */
  get done(): boolean {
    return this.revealedExact >= this.targetLen;
  }

  /**
   * Record the buffer length at `now` (ms). Growth updates the throughput
   * estimate; a shorter buffer (message replaced / re-hydrated) clamps the
   * reveal so it never points past the end.
   */
  observe(targetLen: number, now: number): void {
    if (targetLen > this.targetLen) {
      const added = targetLen - this.targetLen;
      if (this.lastChunkAt !== null) {
        const dt = (now - this.lastChunkAt) / 1000;
        if (dt > 0) {
          const instantCps = added / dt;
          this.cpsEma = this.emaAlpha * instantCps + (1 - this.emaAlpha) * this.cpsEma;
        }
      } else {
        // First growth after mount: show it whole, immediately. Time-to-first-
        // text is perceived latency — pacing starts from the second chunk,
        // once there is a cadence to smooth against.
        this.revealedExact = targetLen;
      }
      this.lastChunkAt = now;
    }
    this.targetLen = targetLen;
    if (this.revealedExact > targetLen) this.revealedExact = targetLen;
  }

  /**
   * The reveal speed (chars/sec) that will be applied next tick: the throughput
   * estimate, floored by `minCps`, and raised so the current backlog drains
   * within `maxLagMs` (this is what bounds the on-screen lag to ~1s).
   */
  effectiveCps(): number {
    const remaining = this.targetLen - this.revealedExact;
    const catchUp = remaining > 0 ? (remaining / this.maxLagMs) * 1000 : 0;
    return Math.max(this.cpsEma, catchUp, this.minCps);
  }

  /** Advance the reveal toward the buffer for the elapsed time; returns `revealed`. */
  tick(now: number): number {
    if (this.lastTickAt === null) {
      this.lastTickAt = now;
      return this.revealed;
    }
    const dt = (now - this.lastTickAt) / 1000;
    this.lastTickAt = now;
    if (dt <= 0) return this.revealed;
    const remaining = this.targetLen - this.revealedExact;
    if (remaining <= 0) return this.revealed;
    this.revealedExact = Math.min(this.targetLen, this.revealedExact + this.effectiveCps() * dt);
    return this.revealed;
  }

  /** Reveal the whole buffer instantly (turn end, interrupt, error, selection). */
  flush(): number {
    this.revealedExact = this.targetLen;
    return this.revealed;
  }

  /** Snap revealed and target to `len` and clear timing (mount / passthrough). */
  reset(len: number): void {
    this.revealedExact = Math.max(0, len);
    this.targetLen = this.revealedExact;
    this.lastTickAt = null;
    this.lastChunkAt = null;
    this.cpsEma = this.minCps;
  }
}
