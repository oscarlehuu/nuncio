// Hidden layer for implement-function-from-spec: import the engine's built
// mergeIntervals from the fixture and run 8 held-out cases the shipped tests do
// not cover — adjacency, unsorted, single, empty, containment, duplicates,
// input-mutation (deep-frozen input), negatives. All 8 must pass. The probe runs
// inside the fixture dir (bun) so it resolves the fixture's own module graph.
import { spawnSync } from 'node:child_process';
import { testDirUnchanged } from './lib/check-helpers.mjs';

const PROBE = `
import { mergeIntervals } from './src/merge-intervals.ts';

const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const cases = [];
const check = (name, got, want) => cases.push({ name, ok: eq(got, want) });

check('adjacency merges', mergeIntervals([[1, 2], [2, 3]]), [[1, 3]]);
check('unsorted input', mergeIntervals([[5, 6], [1, 3], [2, 4]]), [[1, 4], [5, 6]]);
check('single interval', mergeIntervals([[4, 8]]), [[4, 8]]);
check('empty input', mergeIntervals([]), []);
check('full containment', mergeIntervals([[1, 10], [3, 5]]), [[1, 10]]);
check('duplicate intervals', mergeIntervals([[2, 4], [2, 4]]), [[2, 4]]);
check('negative numbers', mergeIntervals([[-5, -2], [-3, 0]]), [[-5, 0]]);

// input-mutation probes: deep-freeze the input AND its tuples; a mutating
// implementation throws in strict mode (ESM is strict), failing the case.
const probeNoMutation = (name, input, want) => {
  input.forEach((t) => Object.freeze(t));
  Object.freeze(input);
  let ok = true;
  try {
    if (!eq(mergeIntervals(input), want)) ok = false;
  } catch {
    ok = false; // threw => it tried to mutate a frozen tuple/array
  }
  cases.push({ name, ok });
};
// Non-overlapping: catches whole-array/tuple reassignment.
probeNoMutation('no mutation (disjoint)', [[9, 10], [1, 2]], [[1, 2], [9, 10]]);
// OVERLAPPING multi-merge: the merge step is where a lazy impl mutates the
// accumulator tuple in place (last[1] = ...); with frozen tuples that throws.
probeNoMutation('no mutation (overlapping merge)', [[1, 4], [2, 6], [5, 8]], [[1, 8]]);

const passed = cases.filter((c) => c.ok).length;
console.log(JSON.stringify({ passed, total: cases.length, failed: cases.filter((c) => !c.ok).map((c) => c.name) }));
`;

export default function check({ fixtureDir }) {
  const notes = [];
  const testClean = testDirUnchanged(fixtureDir);
  if (!testClean) notes.push('test/ was modified — implement the spec, do not weaken tests');

  const res = spawnSync('bun', ['-e', PROBE], { cwd: fixtureDir, encoding: 'utf8', stdio: 'pipe' });
  if (res.status !== 0) {
    return { pass: false, notes: [...notes, `held-out probe failed to run: ${(res.stderr || res.stdout || '').slice(-300)}`] };
  }
  let report;
  try {
    report = JSON.parse(res.stdout.trim().split('\n').pop());
  } catch {
    return { pass: false, notes: [...notes, `could not parse probe output: ${res.stdout.slice(-200)}`] };
  }
  const heldOk = report.passed === report.total;
  notes.push(`held-out cases ${report.passed}/${report.total}`);
  if (!heldOk) notes.push(`failed: ${report.failed.join(', ')}`);
  return { pass: testClean && heldOk, notes };
}
