// Regression/improvement compare for two eval reports. A prompt/profile change
// becomes a measured, signed delta: pass→fail is a REGRESSION (exit 1), fail→pass
// an improvement, and a per-task duration change > 50% is flagged. Informational
// (control) rows are compared and shown but NEVER drive the exit code. Comparing
// across suite versions is a hard error — the task set changed, so the numbers
// are not comparable.
//   bun run eval:compare -- <reportA> <reportB>
//   bun run eval:compare -- <reportB> --against-baseline <engine>[-<model>]
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { baselinesDir } from './lib/eval-suite.mjs';

const DURATION_FLAG = 0.5; // >50% change

function loadReport(path) {
  if (!existsSync(path)) throw new Error(`report not found: ${path}`);
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`report is not valid JSON (${path}): ${err.message}`);
  }
}

/** Resolve --against-baseline <engine>[-<model>] to a baseline file. */
function resolveBaseline(spec) {
  const exact = join(baselinesDir, `${spec}.json`);
  if (existsSync(exact)) return exact;
  // Prefix match: `mock` → `mock-<model>.json` (unique or first).
  const matches = existsSync(baselinesDir)
    ? readdirSync(baselinesDir).filter((f) => f.endsWith('.json') && (f === `${spec}.json` || f.startsWith(`${spec}-`)))
    : [];
  if (matches.length === 0) throw new Error(`no baseline matches "${spec}" under ${baselinesDir}`);
  if (matches.length > 1) throw new Error(`ambiguous baseline "${spec}": ${matches.join(', ')} — pass <engine>-<model>`);
  return join(baselinesDir, matches[0]);
}

function parseArgs(argv) {
  const positional = [];
  let againstBaseline = null;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--against-baseline') againstBaseline = argv[(i += 1)];
    else positional.push(argv[i]);
  }
  return { positional, againstBaseline };
}

const byTaskId = (report) => new Map((report.results ?? []).map((r) => [r.taskId, r]));

function classify(a, b) {
  // a = baseline row, b = current row (either may be undefined).
  if (!a && b) return 'added';
  if (a && !b) return 'removed';
  const was = a.pass === true;
  const now = b.pass === true;
  if (was && !now) return 'regression';
  if (!was && now) return 'improvement';
  return now ? 'pass' : 'fail';
}

function durationDelta(a, b) {
  if (!a || !b || !a.durationMs || !b.durationMs) return null;
  const ratio = (b.durationMs - a.durationMs) / a.durationMs;
  return Math.abs(ratio) > DURATION_FLAG ? ratio : null;
}

export function compareReports(reportA, reportB) {
  if (reportA.suiteVersion !== reportB.suiteVersion) {
    throw new Error(
      `suiteVersion mismatch: ${reportA.suiteVersion} vs ${reportB.suiteVersion} — never compare across suite versions (the task set changed)`,
    );
  }
  const aMap = byTaskId(reportA);
  const bMap = byTaskId(reportB);
  const taskIds = [...new Set([...aMap.keys(), ...bMap.keys()])].sort();

  const rows = [];
  let regressions = 0;
  let improvements = 0;
  for (const taskId of taskIds) {
    const a = aMap.get(taskId);
    const b = bMap.get(taskId);
    const verdict = classify(a, b);
    const informational = (b ?? a)?.informational === true;
    // Only GRADED regressions gate the exit code.
    if (verdict === 'regression' && !informational) regressions += 1;
    if (verdict === 'improvement' && !informational) improvements += 1;
    rows.push({ taskId, verdict, informational, durationRatio: durationDelta(a, b) });
  }
  return { rows, regressions, improvements };
}

function render({ rows, regressions, improvements }, labelA, labelB) {
  const lines = [`## eval compare — ${labelA} → ${labelB}`, '', '| task | verdict | duration |', '|---|---|---|'];
  const VERDICT = { regression: 'REGRESSION ⛔', improvement: 'improvement ✅', pass: 'pass', fail: 'fail', added: 'added', removed: 'removed' };
  for (const r of rows) {
    const task = r.informational ? `${r.taskId} (info)` : r.taskId;
    const dur = r.durationRatio === null ? '' : `${r.durationRatio > 0 ? '+' : ''}${Math.round(r.durationRatio * 100)}%`;
    lines.push(`| ${task} | ${VERDICT[r.verdict] ?? r.verdict} | ${dur} |`);
  }
  lines.push('', `regressions: ${regressions}  improvements: ${improvements}`);
  return lines.join('\n');
}

function main() {
  const { positional, againstBaseline } = parseArgs(process.argv.slice(2));
  let pathA;
  let pathB;
  if (againstBaseline) {
    if (positional.length !== 1) {
      console.error('usage: eval:compare -- <report> --against-baseline <engine>[-<model>]');
      process.exit(2);
    }
    pathA = resolveBaseline(againstBaseline); // baseline is the "before"
    pathB = positional[0];
  } else {
    if (positional.length !== 2) {
      console.error('usage: eval:compare -- <reportA> <reportB>   (or --against-baseline <engine>)');
      process.exit(2);
    }
    [pathA, pathB] = positional;
  }

  let reportA;
  let reportB;
  let result;
  try {
    reportA = loadReport(pathA);
    reportB = loadReport(pathB);
    result = compareReports(reportA, reportB);
  } catch (err) {
    console.error(`[eval:compare] ${err.message}`);
    process.exit(2);
  }

  console.log(render(result, `${reportA.engine}/${reportA.model}@v${reportA.suiteVersion}`, `${reportB.engine}/${reportB.model}@v${reportB.suiteVersion}`));
  // A regression is the gate; improvements and duration flags are informational.
  process.exit(result.regressions > 0 ? 1 : 0);
}

// Only run main when invoked directly (the spec imports compareReports).
if (import.meta.main) main();
