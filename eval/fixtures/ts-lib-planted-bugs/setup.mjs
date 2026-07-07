// Fixture: a two-branch repo for a read-only diff review. `main` has a clean
// baseline; `feature/session-cache` adds a cache implementation whose diff
// contains EXACTLY three planted correctness bugs plus two benign decoys. The
// task writes findings to reviews/findings.json and must change no code on
// either branch. The planted-bug locations (branch-side file + line) are the
// ground truth the hidden check scores against. Zero dependencies.
import { buildBranchedFixture } from '../lib/deterministic-git.mjs';

// Ground truth: the planted bug lines are on the BRANCH version of each file.
// Kept here so the hidden check imports them rather than re-deriving.
export const PLANTED_BUGS = [
  { file: 'src/lru.ts', line: 19, kind: 'off-by-one in LRU eviction' },
  { file: 'src/writer.ts', line: 10, kind: 'swallowed promise rejection' },
  { file: 'src/cache-key.ts', line: 4, kind: 'getHours vs getUTCHours (timezone)' },
];

// Commit counts each branch has AT BUILD TIME (main seed; feature = seed + its
// own commit). The review hidden check asserts these are unchanged — the
// reviewer must not commit anything on either branch.
export const EXPECTED_COMMITS = { main: 1, 'feature/session-cache': 2 };

const MAIN = {
  'package.json': `${JSON.stringify(
    { name: 'ts-lib-planted-bugs', version: '0.0.0', private: true, scripts: { test: 'bun test' } },
    null,
    2,
  )}\n`,
  'src/index.ts': `export const NAME = 'session-cache';\n`,
  'README.md': '# session-cache\n\nBaseline before the feature branch.\n',
};

// The branch overlay. Line numbers below are 1-based within each file as written.
const BRANCH = {
  // src/lru.ts — planted bug: off-by-one in the eviction loop (line 18).
  'src/lru.ts': `export class Lru<V> {
  private readonly order: string[] = [];
  private readonly map = new Map<string, V>();

  constructor(private readonly capacity: number) {}

  get(key: string): V | undefined {
    return this.map.get(key);
  }

  set(key: string, value: V): void {
    if (!this.map.has(key)) this.order.push(key);
    this.map.set(key, value);
    this.evict();
  }

  private evict(): void {
    // BUG (off-by-one): should evict while size > capacity, not >= capacity + 1.
    while (this.order.length > this.capacity + 1) {
      const oldest = this.order.shift();
      if (oldest) this.map.delete(oldest);
    }
  }
}
`,
  // src/writer.ts — planted bug: swallowed promise rejection on a write path (line 10).
  'src/writer.ts': `export interface Store {
  write(key: string, value: string): Promise<void>;
}

export class CacheWriter {
  constructor(private readonly store: Store) {}

  persist(key: string, value: string): void {
    // BUG: the rejection is swallowed — a failed write is silently lost.
    this.store.write(key, value).catch(() => {});
  }
}
`,
  // src/cache-key.ts — planted bug: getHours instead of getUTCHours (line 6).
  'src/cache-key.ts': `export function cacheKey(id: string, at: Date): string {
  // The key must be stable regardless of the server's timezone, so it must use
  // UTC. BUG: getHours() is local-time and shifts the key across timezones.
  const bucket = at.getHours();
  return \`\${id}:\${bucket}\`;
}
`,
  // src/reduce-total.ts — DECOY 1: an unusual-but-correct reduce (no bug).
  'src/reduce-total.ts': `export function total(nums: number[]): number {
  // Unusual style, but correct: seeds with the first element via slice.
  return nums.length === 0 ? 0 : nums.slice(1).reduce((a, b) => a + b, nums[0]);
}
`,
  // src/coerce.ts — DECOY 2: a deliberate any-cast with an explanatory comment.
  'src/coerce.ts': `export function coerce(input: unknown): string {
  // Intentional cast: the caller guarantees a string at this boundary (see
  // validateInput upstream); a runtime guard here would be dead code.
  return input as any as string;
}
`,
  'src/index.ts': `export { Lru } from './lru';
export { CacheWriter } from './writer';
export { cacheKey } from './cache-key';
export { total } from './reduce-total';
export { coerce } from './coerce';
`,
};

export async function setup(dir) {
  await buildBranchedFixture(
    dir,
    { files: MAIN, message: 'feat: baseline' },
    { name: 'feature/session-cache', files: BRANCH, message: 'feat: add session cache' },
  );
  return dir;
}
