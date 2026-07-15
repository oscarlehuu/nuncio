// Dead-code ratchet: run knip over the whole monorepo and fail only on NEW
// findings beyond the committed baseline (scripts/dead-code-baseline.json).
// Existing findings are debt to burn down, not a reason to block PRs.
//
// Usage: bun run check-dead-code            (CI gate: fail on new dead code)
//        bun run check-dead-code:update     (rewrite the baseline from current state)
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { diffIssueKeys, issueKeysFromReport } from './dead-code-utils.mjs';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const BASELINE_PATH = join(repoRoot, 'scripts', 'dead-code-baseline.json');
const UPDATE = process.argv.includes('--update');

async function runKnip() {
  const proc = Bun.spawn(['bunx', 'knip', '--reporter', 'json', '--no-exit-code'], {
    cwd: repoRoot,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  let report;
  try {
    report = JSON.parse(stdout);
  } catch {
    console.error('[dead-code] knip did not produce JSON output');
    console.error(stderr.trim() || stdout.trim());
    process.exit(1);
  }
  if (exitCode !== 0) {
    console.error(`[dead-code] knip exited ${exitCode} (configuration error?)`);
    console.error(stderr.trim());
    process.exit(1);
  }
  return report;
}

const current = issueKeysFromReport(await runKnip());

if (UPDATE) {
  await writeFile(
    BASELINE_PATH,
    `${JSON.stringify({ note: 'knip findings accepted as existing debt; burn down over time. Regenerate with: bun run check-dead-code:update', issues: current }, null, 2)}\n`,
  );
  console.log(`[dead-code] baseline updated: ${current.length} accepted findings`);
  process.exit(0);
}

let baseline;
try {
  baseline = JSON.parse(await readFile(BASELINE_PATH, 'utf8')).issues;
} catch {
  console.error(`[dead-code] missing/unreadable baseline at ${BASELINE_PATH}`);
  console.error('[dead-code] generate it with: bun run check-dead-code:update');
  process.exit(1);
}

const { added, fixed } = diffIssueKeys(current, baseline);

if (fixed.length > 0) {
  console.log(`[dead-code] ${fixed.length} baseline finding(s) no longer present — shrink the baseline:`);
  for (const key of fixed) console.log(`  fixed: ${key}`);
  console.log('  run: bun run check-dead-code:update');
}

if (added.length > 0) {
  console.error(`[dead-code] FAIL — ${added.length} new dead-code finding(s) not in the baseline:`);
  for (const key of added) console.error(`  new: ${key}`);
  console.error('[dead-code] delete the dead code, wire it up, or (if intentional) run: bun run check-dead-code:update');
  process.exit(1);
}

console.log(`[dead-code] PASS — no new findings (baseline debt: ${baseline.length})`);
