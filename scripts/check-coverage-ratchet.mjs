// Coverage ratchet: line coverage may only go up. Reads the reports produced
// by the coverage test runs and fails any target that dropped below the
// committed floor (scripts/coverage-baseline.json).
//
// Generate the reports first:
//   bun run --filter @nuncio/server test:coverage   → apps/server/coverage/lcov.info
//   bun run --filter @nuncio/web test:coverage      → apps/web/coverage/coverage-summary.json
//
// Usage: bun run check-coverage-ratchet             (CI gate)
//        bun run check-coverage-ratchet:update      (raise the baseline to current)
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import {
  compareCoverageToBaseline,
  lineCoverageFromLcov,
  lineCoverageFromVitestSummary,
} from './coverage-ratchet-utils.mjs';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const BASELINE_PATH = join(repoRoot, 'scripts', 'coverage-baseline.json');
const UPDATE = process.argv.includes('--update');

const REPORTS = {
  server: {
    path: join(repoRoot, 'apps/server/coverage/lcov.info'),
    command: 'bun run --filter @nuncio/server test:coverage',
    parse: (text) => lineCoverageFromLcov(text),
  },
  web: {
    path: join(repoRoot, 'apps/web/coverage/coverage-summary.json'),
    command: 'bun run --filter @nuncio/web test:coverage',
    parse: (text) => lineCoverageFromVitestSummary(JSON.parse(text)),
  },
};

const current = {};
for (const [target, report] of Object.entries(REPORTS)) {
  try {
    current[target] = Math.round(report.parse(await readFile(report.path, 'utf8')) * 100) / 100;
  } catch (err) {
    console.error(`[coverage] cannot read ${target} report at ${report.path}: ${err.message}`);
    console.error(`[coverage] generate it with: ${report.command}`);
    process.exit(1);
  }
}

if (UPDATE) {
  const baseline = { tolerancePct: 0.25, targets: current };
  await writeFile(BASELINE_PATH, `${JSON.stringify(baseline, null, 2)}\n`);
  console.log(
    `[coverage] baseline updated: ${Object.entries(current)
      .map(([t, v]) => `${t}=${v}%`)
      .join(', ')}`,
  );
  process.exit(0);
}

let baseline;
try {
  baseline = JSON.parse(await readFile(BASELINE_PATH, 'utf8'));
} catch {
  console.error(`[coverage] missing/unreadable baseline at ${BASELINE_PATH}`);
  console.error('[coverage] generate it with: bun run check-coverage-ratchet:update');
  process.exit(1);
}

const { failures, improved } = compareCoverageToBaseline(current, baseline);

for (const [target, value] of Object.entries(current)) {
  console.log(`[coverage] ${target}: ${value}% lines (floor ${baseline.targets[target] - baseline.tolerancePct}%)`);
}

if (improved.length > 0) {
  console.log(
    `[coverage] ${improved.join(', ')} improved beyond the baseline — ratchet it up: bun run check-coverage-ratchet:update`,
  );
}

if (failures.length > 0) {
  for (const f of failures) {
    console.error(
      `[coverage] FAIL — ${f.target}: ${f.current ?? 'no report'}% < floor ${f.floor}% (baseline ${f.baseline}%)`,
    );
  }
  console.error('[coverage] add tests for the new code, or justify a baseline decrease in the PR.');
  process.exit(1);
}

console.log('[coverage] PASS — no target below its ratchet floor');
