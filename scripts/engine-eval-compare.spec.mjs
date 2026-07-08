// D5 compare + baseline tests. compareReports is pure (fixture reports in
// memory); the baseline-refusal and round-trip cases drive the real runner over
// the mock smoke task. Runs under `bun run test:scripts`.
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareReports } from './engine-eval-compare.mjs';
import { isCompleteReport } from './lib/eval-suite.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const baselinesDir = join(repoRoot, 'eval', 'baselines');
const reportsDir = join(repoRoot, 'eval', 'reports');

function report(overrides = {}) {
  return {
    suiteVersion: 1,
    engine: 'mock',
    model: 'mock:default',
    profileVersion: 0,
    results: [],
    passRate: 0,
    tokens: null,
    ...overrides,
  };
}
const rowOf = (taskId, extra = {}) => ({ taskId, informational: false, pass: true, verifyPassed: true, hiddenPassed: true, durationMs: 1000, rounds: 1, notes: [], ...extra });

describe('compareReports', () => {
  test('a pass→fail is a regression and gates the exit code', () => {
    const a = report({ results: [rowOf('t1', { pass: true })] });
    const b = report({ results: [rowOf('t1', { pass: false })] });
    const res = compareReports(a, b);
    expect(res.regressions).toBe(1);
    expect(res.rows[0].verdict).toBe('regression');
  });

  test('a fail→pass is an improvement (does not gate)', () => {
    const a = report({ results: [rowOf('t1', { pass: false })] });
    const b = report({ results: [rowOf('t1', { pass: true })] });
    const res = compareReports(a, b);
    expect(res.regressions).toBe(0);
    expect(res.improvements).toBe(1);
    expect(res.rows[0].verdict).toBe('improvement');
  });

  test('a duration change > 50% is flagged, <= 50% is not', () => {
    const a = report({ results: [rowOf('t1', { durationMs: 1000 }), rowOf('t2', { durationMs: 1000 })] });
    const b = report({ results: [rowOf('t1', { durationMs: 2000 }), rowOf('t2', { durationMs: 1400 })] });
    const res = compareReports(a, b);
    const t1 = res.rows.find((r) => r.taskId === 't1');
    const t2 = res.rows.find((r) => r.taskId === 't2');
    expect(t1.durationRatio).toBeGreaterThan(0.5);
    expect(t2.durationRatio).toBe(null); // +40% < 50%
  });

  test('a suiteVersion mismatch is a hard error', () => {
    const a = report({ suiteVersion: 1, results: [rowOf('t1')] });
    const b = report({ suiteVersion: 2, results: [rowOf('t1')] });
    expect(() => compareReports(a, b)).toThrow(/suiteVersion mismatch/);
  });

  test('informational (control) rows are compared but never gate the exit code', () => {
    const a = report({ results: [rowOf('ctrl', { informational: true, pass: true })] });
    const b = report({ results: [rowOf('ctrl', { informational: true, pass: false })] });
    const res = compareReports(a, b);
    // The row still shows as a regression, but the graded regression count is 0.
    expect(res.rows[0].verdict).toBe('regression');
    expect(res.regressions).toBe(0);
  });
});

describe('isCompleteReport', () => {
  test('a report with a skip row is incomplete', () => {
    expect(isCompleteReport(report({ results: [rowOf('t1', { pass: false, notes: ['skipped: not installed'] })] }))).toBe(false);
  });
  test('a report with a timeout row is incomplete', () => {
    expect(isCompleteReport(report({ results: [rowOf('t1', { pass: false, notes: ['timeout after 300000ms'] })] }))).toBe(false);
  });
  test('a report whose rows all ran (even failing) is complete', () => {
    expect(isCompleteReport(report({ results: [rowOf('t1', { pass: false, notes: ['task DONE', 'assertion failed'] })] }))).toBe(true);
  });
});

// End-to-end: a real mock run writes a baseline; --against-baseline resolves it;
// an infra-skip run is refused. These boot a hermetic daemon (seconds each).
function runEval(args) {
  return spawnSync('bun', ['scripts/engine-eval.mjs', ...args], { cwd: repoRoot, encoding: 'utf8' });
}
function latestReport() {
  const files = readdirSync(reportsDir).filter((f) => f.endsWith('.json'));
  files.sort();
  return join(reportsDir, files[files.length - 1]);
}

describe('baseline write + compare round-trip (mock, end-to-end)', () => {
  test(
    'a complete mock run writes a baseline that --against-baseline resolves to exit 0',
    () => {
      // Clean any prior baseline so the assertion is unambiguous.
      const baselineFile = join(baselinesDir, 'mock-mock-default.json');
      rmSync(baselineFile, { force: true });

      const write = runEval(['--engines', 'mock', '--tasks', 'smoke-mock-echo', '--baseline']);
      expect(write.status, `baseline run failed:\n${write.stdout}\n${write.stderr}`).toBe(0);
      expect(existsSync(baselineFile), 'baseline file not written').toBe(true);
      const baseline = JSON.parse(readFileSync(baselineFile, 'utf8'));
      expect(baseline.results[0].taskId).toBe('smoke-mock-echo');

      // A fresh identical run compared against the baseline → no regression, exit 0.
      const rerun = runEval(['--engines', 'mock', '--tasks', 'smoke-mock-echo']);
      expect(rerun.status).toBe(0);
      const cmp = spawnSync('bun', ['scripts/engine-eval-compare.mjs', latestReport(), '--against-baseline', 'mock'], { cwd: repoRoot, encoding: 'utf8' });
      expect(cmp.status, `compare failed:\n${cmp.stdout}\n${cmp.stderr}`).toBe(0);
      expect(cmp.stdout).toContain('regressions: 0');

      // Clean up the test baseline — a real suite baseline is founder-generated,
      // not a single-task test artifact left in the tree.
      rmSync(baselineFile, { force: true });
    },
    120000,
  );

  test(
    'a run with an infra skip refuses --baseline',
    () => {
      // codex is not authenticated in the hermetic daemon → skipped row.
      const res = runEval(['--engines', 'codex', '--tasks', 'smoke-mock-echo', '--baseline']);
      expect(res.status).not.toBe(0);
      expect(res.stderr + res.stdout).toMatch(/refusing --baseline/);
    },
    120000,
  );
});
