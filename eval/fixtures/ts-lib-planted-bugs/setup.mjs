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
  { file: 'src/cache-key.ts', line: 3, kind: 'getHours vs getUTCHours (timezone)' },
];

// The fixture is deterministic (proven by the determinism spec), so both branch
// tip SHAs are byte-stable and can be PINNED. The review hidden check asserts an
// exact match — this is the primary integrity anchor: it catches a `git commit
// --amend` (which a commit-count check misses) and any new commit, because the
// tip SHA changes. Regenerate these whenever the fixture content changes.
export const PINNED_SHAS = {
  main: '57713736cbcb02b244ec9be6d1f4232748b44eb1',
  'feature/session-cache': '2aa3972386f4a49d6cf17a47017aa103a13446a2',
};

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
    // Keep the cache within capacity by dropping the oldest entries.
    while (this.order.length > this.capacity + 1) {
      const oldest = this.order.shift();
      if (oldest) this.map.delete(oldest);
    }
  }
}
`,
  // src/writer.ts — planted (unmarked) bug: swallowed promise rejection.
  'src/writer.ts': `export interface Store {
  write(key: string, value: string): Promise<void>;
}

export class CacheWriter {
  constructor(private readonly store: Store) {}

  persist(key: string, value: string): void {
    // Fire the write; failures are handled by the caller's retry layer.
    this.store.write(key, value).catch(() => {});
  }
}
`,
  // src/cache-key.ts — planted (unmarked) bug: getHours instead of getUTCHours.
  'src/cache-key.ts': `export function cacheKey(id: string, at: Date): string {
  // Bucket the timestamp by hour to group cache entries.
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
