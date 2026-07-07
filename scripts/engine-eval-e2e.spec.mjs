// End-to-end harness proof: `eval:engines --engines mock --tasks smoke-mock-echo`
// must exit 0, write a report file, and score the task pass=true. This exercises
// the WHOLE loop — fixture build, hermetic daemon boot, facts/enqueue,
// verify-layer + hidden-layer scoring, report shape — against the zero-credential
// Mock provider. Runs from the repo root via `bun run test:scripts`, so it is
// CI-runnable with no external setup. Booting a real daemon takes seconds, hence
// the generous timeout.
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(scriptDir, '..');
const reportsDir = join(repoRoot, 'eval', 'reports');

describe('engine-eval harness (mock end-to-end)', () => {
  test(
    'mock proof task runs green and writes a passing report',
    () => {
      const before = new Set(safeReaddir(reportsDir));

      const res = spawnSync(
        'bun',
        ['scripts/engine-eval.mjs', '--engines', 'mock', '--tasks', 'smoke-mock-echo'],
        { cwd: repoRoot, encoding: 'utf8' },
      );

      expect(res.status, `runner failed:\n${res.stdout}\n${res.stderr}`).toBe(0);

      const after = safeReaddir(reportsDir);
      const fresh = after.filter((f) => !before.has(f) && f.endsWith('.json'));
      expect(fresh.length).toBeGreaterThan(0);

      const report = JSON.parse(readFileSync(join(reportsDir, fresh[0]), 'utf8'));
      expect(report.suiteVersion).toBe(1);
      expect(report.engine).toBe('mock');
      expect(report.results).toHaveLength(1);
      const [row] = report.results;
      expect(row.taskId).toBe('smoke-mock-echo');
      expect(row.pass).toBe(true);
      expect(row.verifyPassed).toBe(true);
      expect(row.hiddenPassed).toBe(true);
    },
    120000,
  );
});

function safeReaddir(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}
