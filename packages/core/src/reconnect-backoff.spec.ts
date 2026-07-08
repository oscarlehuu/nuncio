import { describe, expect, it } from 'vitest';
import { fullJitterBackoff } from './reconnect-backoff';

describe('fullJitterBackoff', () => {
  it('scales the window exponentially from the base, clamped at the cap', () => {
    // random()=1 exposes the upper edge of each window (the value is in [0,window)).
    const max = { random: () => 1, baseMs: 500, capMs: 8000 };
    expect(fullJitterBackoff(1, max)).toBe(500); // 500 * 2^0
    expect(fullJitterBackoff(2, max)).toBe(1000); // 500 * 2^1
    expect(fullJitterBackoff(3, max)).toBe(2000);
    expect(fullJitterBackoff(4, max)).toBe(4000);
    expect(fullJitterBackoff(5, max)).toBe(8000); // clamped
    expect(fullJitterBackoff(9, max)).toBe(8000); // stays clamped
  });

  it('keeps the delay within [0, window) for any random draw', () => {
    for (let attempt = 1; attempt <= 10; attempt++) {
      const window = Math.min(8000, 500 * 2 ** (attempt - 1));
      for (const r of [0, 0.25, 0.5, 0.999]) {
        const delay = fullJitterBackoff(attempt, { random: () => r });
        expect(delay).toBeGreaterThanOrEqual(0);
        expect(delay).toBeLessThanOrEqual(window);
      }
    }
  });

  it('floors a mis-counted attempt below 1 to the base window', () => {
    expect(fullJitterBackoff(0, { random: () => 1 })).toBe(500);
    expect(fullJitterBackoff(-3, { random: () => 1 })).toBe(500);
  });
});
