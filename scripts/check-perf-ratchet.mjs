// UI smoothness ratchet: gated metrics may only get so much slower. Reads the
// medians produced by the measurement pass (scripts/perf-metrics.json, written
// by `bun run perf:ui`) and fails any GATED metric whose median climbed above
// the committed baseline (scripts/perf-baseline.json) by more than the tolerance.
// Report-only metrics are printed but never fail the gate.
//
// Two-step, like the coverage ratchet — measure first, then check:
//   bun run perf:ui                     → scripts/perf-metrics.json
//   bun run check-perf-ratchet          (CI gate)
//   bun run check-perf-ratchet:update   (adopt the current medians as the baseline)
//
// Bootstrap: perf numbers are machine-specific and the GATE baseline must come
// from CI-runner measurements, not a dev laptop. A MISSING baseline is therefore
// a loud non-fatal bootstrap (print the numbers, exit 0) rather than a hard
// error — harvest the CI numbers from the first run and commit them with
// `--update`. A present-but-corrupt baseline IS a hard error.
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import {
  assertValidBaseline,
  ceilingFor,
  compareMetricsToBaseline,
} from './perf-ratchet-utils.mjs';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const METRICS_PATH = join(repoRoot, 'scripts', 'perf-metrics.json');
const BASELINE_PATH = join(repoRoot, 'scripts', 'perf-baseline.json');
const DEFAULT_TOLERANCE = 0.3;
const UPDATE = process.argv.includes('--update');

// Which metrics are gated by default when writing a fresh baseline. Report-only
// metrics are still measured + printed; they carry no pass/fail authority.
const DEFAULT_GATED = {
  ttfdMs: true,
  scrollSweepMs: true,
  keyEchoMs: true,
  streamBlockingMs: false,
};
const UNITS = {
  ttfdMs: 'time-to-first-delta',
  scrollSweepMs: 'scroll sweep on a long transcript',
  keyEchoMs: 'composer keypress → echo',
  streamBlockingMs: 'main-thread blocking while streaming',
};

let report;
try {
  report = JSON.parse(await readFile(METRICS_PATH, 'utf8'));
} catch (err) {
  console.error(`[perf] cannot read measurements at ${METRICS_PATH}: ${err.message}`);
  console.error('[perf] produce them first with: bun run perf:ui');
  process.exit(1);
}
const current = report.metrics ?? {};

if (UPDATE) {
  const baseline = {
    tolerancePct: DEFAULT_TOLERANCE,
    note: 'Medians (ms) from a CI-runner measurement; regenerate with `bun run perf:ui` then `bun run check-perf-ratchet:update`.',
    machine: report.machine,
    metrics: Object.fromEntries(
      Object.entries(current).map(([name, s]) => [
        name,
        { median: s.median, gated: DEFAULT_GATED[name] ?? false, label: UNITS[name] ?? name },
      ]),
    ),
  };
  await writeFile(BASELINE_PATH, `${JSON.stringify(baseline, null, 2)}\n`);
  console.log(
    `[perf] baseline updated: ${Object.entries(baseline.metrics)
      .map(([n, m]) => `${n}=${m.median}ms${m.gated ? '' : ' (report-only)'}`)
      .join(', ')}`,
  );
  process.exit(0);
}

let baseline;
try {
  baseline = JSON.parse(await readFile(BASELINE_PATH, 'utf8'));
} catch (err) {
  if (err.code === 'ENOENT') {
    console.log('[perf] BOOTSTRAP — no committed baseline; gate is inactive.');
    console.log('[perf] measured medians (harvest these from CI, then commit with --update):');
    for (const [name, s] of Object.entries(current)) {
      console.log(`  ${name.padEnd(18)} ${s.median} ms  (min ${s.min}, max ${s.max}, cv ${s.cv})`);
    }
    console.log('[perf] set the gate baseline with: bun run check-perf-ratchet:update');
    process.exit(0);
  }
  console.error(`[perf] baseline at ${BASELINE_PATH} is unreadable/corrupt: ${err.message}`);
  process.exit(1);
}

// A baseline can parse as JSON yet be schema-broken (missing tolerancePct, a
// non-numeric median). Reject it here — before the print loop and the compare —
// so a malformed baseline is a hard error, never a silent fail-open PASS.
try {
  assertValidBaseline(baseline);
} catch (err) {
  console.error(`[perf] baseline at ${BASELINE_PATH} is malformed: ${err.message}`);
  console.error('[perf] regenerate it with: bun run perf:ui && bun run check-perf-ratchet:update');
  process.exit(1);
}

const { failures, reportOnly, improved, extras } = compareMetricsToBaseline(current, baseline);
const tol = baseline.tolerancePct;

for (const [name, base] of Object.entries(baseline.metrics)) {
  const measured = current[name]?.median;
  const tag = base.gated ? 'gate ' : 'report';
  const ceiling = base.gated ? ` (ceiling ${ceilingFor(base.median, tol)}ms)` : '';
  console.log(
    `[perf] ${tag} ${name.padEnd(18)} ${measured ?? 'no measurement'}ms vs baseline ${base.median}ms${ceiling}`,
  );
}
if (reportOnly.length > 0) {
  console.log(`[perf] report-only (not gated): ${reportOnly.join(', ')}`);
}
if (improved.length > 0) {
  console.log(`[perf] improved beyond baseline: ${improved.join(', ')} — ratchet down: bun run check-perf-ratchet:update`);
}
if (extras.length > 0) {
  console.log(`[perf] measured but not in baseline: ${extras.join(', ')} — adopt with --update`);
}

if (failures.length > 0) {
  for (const f of failures) {
    console.error(
      `[perf] FAIL — ${f.metric}: ${f.current ?? 'no measurement'}ms > ceiling ${f.ceiling}ms (baseline ${f.baseline}ms +${Math.round(tol * 100)}%)`,
    );
  }
  console.error('[perf] a smoothness budget regressed. Profile the change, or justify a baseline bump in the PR.');
  process.exit(1);
}

console.log('[perf] PASS — every gated smoothness budget within tolerance');
