import { describe, expect, it } from 'bun:test';
import { FixedWindowRateLimiter } from '../../../src/pairing/rate-limit';

const RATE = { max: 3, windowMs: 1000 };

describe('FixedWindowRateLimiter', () => {
  it('allows exactly max requests per window, denies the next', () => {
    let now = 0;
    const limiter = new FixedWindowRateLimiter(() => now);
    expect(limiter.allow('ip', RATE)).toBe(true);
    expect(limiter.allow('ip', RATE)).toBe(true);
    expect(limiter.allow('ip', RATE)).toBe(true);
    expect(limiter.allow('ip', RATE)).toBe(false);
  });

  it('resets once the window fully elapses', () => {
    let now = 0;
    const limiter = new FixedWindowRateLimiter(() => now);
    for (let i = 0; i < RATE.max; i += 1) expect(limiter.allow('ip', RATE)).toBe(true);
    expect(limiter.allow('ip', RATE)).toBe(false);

    now += RATE.windowMs; // window boundary reached → fresh allowance
    expect(limiter.allow('ip', RATE)).toBe(true);
  });

  it('tracks distinct keys independently', () => {
    let now = 0;
    const limiter = new FixedWindowRateLimiter(() => now);
    for (let i = 0; i < RATE.max; i += 1) expect(limiter.allow('a', RATE)).toBe(true);
    expect(limiter.allow('a', RATE)).toBe(false);
    expect(limiter.allow('b', RATE)).toBe(true);
  });
});
