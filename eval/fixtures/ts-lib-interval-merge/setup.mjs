// Fixture: an unimplemented mergeIntervals with the full contract in its doc
// comment. Shipped tests cover only the trivial happy path; the hidden layer
// runs 8 held-out cases (adjacency, unsorted, single, empty, containment,
// duplicates, input-mutation, negatives). Zero dependencies.
import { buildFixture } from '../lib/deterministic-git.mjs';

const FILES = {
  'package.json': `${JSON.stringify(
    { name: 'ts-lib-interval-merge', version: '0.0.0', private: true, scripts: { test: 'bun test' } },
    null,
    2,
  )}\n`,
  'src/merge-intervals.ts': `export type Interval = [start: number, end: number];

/**
 * Merge overlapping intervals.
 *
 * Contract:
 *  - Each interval is [start, end] with start <= end.
 *  - Overlapping intervals merge into one spanning [min start, max end].
 *  - ADJACENT intervals merge too: if end === next.start they become one.
 *  - Input may be unsorted; sort internally.
 *  - Empty input returns an empty array.
 *  - The input array and its interval tuples MUST NOT be mutated.
 *  - Output is sorted ascending by start.
 */
export function mergeIntervals(_intervals: Interval[]): Interval[] {
  throw new Error('not implemented');
}
`,
  'test/merge-intervals.spec.ts': `import { expect, test } from 'bun:test';
import { mergeIntervals } from '../src/merge-intervals';

test('merges two overlapping intervals', () => {
  expect(mergeIntervals([[1, 3], [2, 5]])).toEqual([[1, 5]]);
});

test('leaves a single interval unchanged', () => {
  expect(mergeIntervals([[4, 8]])).toEqual([[4, 8]]);
});
`,
};

export async function setup(dir) {
  await buildFixture(dir, FILES);
  return dir;
}
