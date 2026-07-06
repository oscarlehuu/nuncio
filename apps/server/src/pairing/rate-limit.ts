export interface RateLimitOptions {
  max: number;
  windowMs: number;
}

interface Bucket {
  count: number;
  windowStart: number;
}

/**
 * Tiny fixed-window rate limiter over an in-memory Map. Each key gets `max`
 * allowances per `windowMs`; the window resets when the current one fully
 * elapses. The clock is injectable so windows are deterministically testable.
 * Stale buckets are swept lazily on access to keep memory bounded without a timer.
 */
export class FixedWindowRateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  allow(key: string, options: RateLimitOptions): boolean {
    const t = this.now();
    this.sweep(t, options.windowMs);

    const bucket = this.buckets.get(key);
    if (!bucket || t - bucket.windowStart >= options.windowMs) {
      this.buckets.set(key, { count: 1, windowStart: t });
      return true;
    }
    if (bucket.count >= options.max) {
      return false;
    }
    bucket.count += 1;
    return true;
  }

  private sweep(t: number, windowMs: number): void {
    for (const [key, bucket] of this.buckets) {
      if (t - bucket.windowStart >= windowMs) {
        this.buckets.delete(key);
      }
    }
  }
}
