// Hidden layer for implement-function-from-spec: import the engine's built
// mergeIntervals from the fixture and run 8 held-out cases the shipped tests do
// not cover — adjacency, unsorted, single, empty, containment, duplicates,
// input-mutation (deep-frozen input), negatives. All 8 must pass. The probe runs
// inside the fixture dir (bun) so it resolves the fixture's own module graph.
import { spawnSync } from 'node:child_process';

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

// input-mutation probe: deep-freeze the input and its tuples; a mutating
// implementation throws in strict mode (ESM is strict), failing this case.
const input = [Object.freeze([9, 10]), Object.freeze([1, 2])];
Object.freeze(input);
let mutationOk = true;
try {
  const out = mergeIntervals(input);
  if (!eq(out, [[1, 2], [9, 10]])) mutationOk = false;
} catch {
  mutationOk = false; // threw => it tried to mutate the frozen input
}
cases.push({ name: 'no input mutation', ok: mutationOk });

const passed = cases.filter((c) => c.ok).length;
console.log(JSON.stringify({ passed, total: cases.length, failed: cases.filter((c) => !c.ok).map((c) => c.name) }));
`;

export default function check({ fixtureDir }) {
  const res = spawnSync('bun', ['-e', PROBE], { cwd: fixtureDir, encoding: 'utf8', stdio: 'pipe' });
  if (res.status !== 0) {
    return { pass: false, notes: [`held-out probe failed to run: ${(res.stderr || res.stdout || '').slice(-300)}`] };
  }
  let report;
  try {
    report = JSON.parse(res.stdout.trim().split('\n').pop());
  } catch {
    return { pass: false, notes: [`could not parse probe output: ${res.stdout.slice(-200)}`] };
  }
  const pass = report.passed === report.total;
  const notes = [`held-out cases ${report.passed}/${report.total}`];
  if (!pass) notes.push(`failed: ${report.failed.join(', ')}`);
  return { pass, notes };
}
