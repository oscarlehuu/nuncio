// Fixture: a tiny HTTP-handler package missing a fixed-window rate-limit check.
// The rate-limit test suite is present but skipped (describe.skip), so bun test
// is green-but-hollow at HEAD. The engine receives a full handoff brief (goal +
// constraints + decisions) through the real A1 pipeline and must implement
// src/middleware/rate-limit.ts and unskip the suite. Zero dependencies.
import { buildFixture } from '../lib/deterministic-git.mjs';

const FILES = {
  'package.json': `${JSON.stringify(
    { name: 'ts-svc-ratelimit', version: '0.0.0', private: true, scripts: { test: 'bun test' } },
    null,
    2,
  )}\n`,
  // The stub the engine must implement. Currently allows everything (no limit).
  'src/middleware/rate-limit.ts': `export interface RateLimitOptions {
  /** Max requests allowed within the window. */
  limit: number;
  /** Window length in milliseconds. */
  windowMs: number;
}

export interface RateLimiter {
  /** Returns true if the request from \`key\` is allowed, false if limited. */
  allow(key: string, now: number): boolean;
}

/**
 * Create a fixed-window rate limiter: each key gets \`limit\` requests per
 * \`windowMs\` window; the window resets when \`now\` crosses into the next window.
 * NOT YET IMPLEMENTED — currently allows every request.
 */
export function createRateLimiter(_options: RateLimitOptions): RateLimiter {
  return {
    allow(_key: string, _now: number): boolean {
      return true;
    },
  };
}
`,
  // Must not be touched (a constraint in the brief).
  'src/server.ts': `import { createRateLimiter } from './middleware/rate-limit';

export const limiter = createRateLimiter({ limit: 3, windowMs: 1000 });

export function handle(key: string, now: number): number {
  return limiter.allow(key, now) ? 200 : 429;
}
`,
  // The rate-limit suite is SKIPPED at HEAD — the engine must unskip it and make
  // it pass. A non-rate-limit test stays active so the suite is green at HEAD.
  'test/rate-limit.spec.ts': `import { describe, expect, test } from 'bun:test';
import { createRateLimiter } from '../src/middleware/rate-limit';

describe.skip('fixed-window rate limiter', () => {
  test('allows up to the limit within a window', () => {
    const rl = createRateLimiter({ limit: 3, windowMs: 1000 });
    expect(rl.allow('a', 0)).toBe(true);
    expect(rl.allow('a', 10)).toBe(true);
    expect(rl.allow('a', 20)).toBe(true);
    expect(rl.allow('a', 30)).toBe(false);
  });

  test('resets when the window rolls over', () => {
    const rl = createRateLimiter({ limit: 2, windowMs: 1000 });
    expect(rl.allow('b', 0)).toBe(true);
    expect(rl.allow('b', 1)).toBe(true);
    expect(rl.allow('b', 2)).toBe(false);
    expect(rl.allow('b', 1000)).toBe(true);
  });

  test('tracks keys independently', () => {
    const rl = createRateLimiter({ limit: 1, windowMs: 1000 });
    expect(rl.allow('x', 0)).toBe(true);
    expect(rl.allow('y', 0)).toBe(true);
    expect(rl.allow('x', 1)).toBe(false);
  });
});
`,
  'test/server.spec.ts': `import { expect, test } from 'bun:test';
import { handle } from '../src/server';

test('handle returns 200 when allowed', () => {
  expect(handle('z', 0)).toBe(200);
});
`,
};

export async function setup(dir) {
  await buildFixture(dir, FILES);
  return dir;
}
