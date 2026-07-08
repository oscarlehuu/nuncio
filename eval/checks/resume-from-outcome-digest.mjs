// Hidden layer for resume-from-outcome-digest: step 2 must trust step 1's digest,
// not redo step 1. (a) src/csv-parse.ts and its test are byte-identical to HEAD;
// (b) no write/edit tool event targeted a csv-parse path (behavior, belt to the
// final-state suspenders); (c) the stringifier quotes per RFC 4180 on a held-out
// comma+quote+newline case (round-trip probe inside the fixture).
import { spawnSync } from 'node:child_process';
import { showHead, readWorktree } from './lib/check-helpers.mjs';

const WRITE_TOOL = /(write|edit|create|patch|apply|replace)/i;
const CSV_PARSE_PATH = /csv-parse/;

function touchedStepOneViaTool(events) {
  for (const e of Array.isArray(events) ? events : []) {
    if (e?.type !== 'tool_start') continue;
    const tool = String(e.payload?.tool ?? '');
    const input = JSON.stringify(e.payload?.input ?? '');
    if (WRITE_TOOL.test(tool) && CSV_PARSE_PATH.test(input)) return true;
  }
  return false;
}

const HELD_OUT_PROBE = `
import { stringifyCsv } from './src/csv-stringify.ts';
import { parseCsv } from './src/csv-parse.ts';
// RFC 4180 held-out: a field with a comma, a quote, and a newline.
const rows = [['a,b', 'c"d', 'e\\nf']];
const out = stringifyCsv(rows);
const roundTrips = JSON.stringify(parseCsv(out)) === JSON.stringify(rows);
// The tricky field must be quoted and its inner quote doubled.
const quoted = out.includes('"a,b"') && out.includes('"c""d"');
console.log(JSON.stringify({ roundTrips, quoted, out }));
`;

export default function check({ fixtureDir, sessionEvents }) {
  const notes = [];

  const parseUnchanged = showHead(fixtureDir, 'src/csv-parse.ts') === readWorktree(fixtureDir, 'src/csv-parse.ts');
  const parseTestUnchanged =
    showHead(fixtureDir, 'test/csv-parse.spec.ts') === readWorktree(fixtureDir, 'test/csv-parse.spec.ts');
  if (!parseUnchanged) notes.push('src/csv-parse.ts differs from HEAD — step 1 must not be reimplemented');
  if (!parseTestUnchanged) notes.push('test/csv-parse.spec.ts differs from HEAD — step 1 test must not change');

  const wroteStepOne = touchedStepOneViaTool(sessionEvents);
  if (wroteStepOne) notes.push('a write/edit tool event targeted a csv-parse path (step 1 must be trusted, not rewritten)');

  const res = spawnSync('bun', ['-e', HELD_OUT_PROBE], { cwd: fixtureDir, encoding: 'utf8', stdio: 'pipe' });
  let rfcOk = false;
  if (res.status !== 0) {
    notes.push(`RFC-4180 probe failed to run: ${(res.stderr || res.stdout || '').slice(-200)}`);
  } else {
    try {
      const r = JSON.parse(res.stdout.trim().split('\n').pop());
      rfcOk = r.roundTrips && r.quoted;
      if (!rfcOk) notes.push(`RFC-4180 held-out failed (roundTrips=${r.roundTrips}, quoted=${r.quoted}, out=${JSON.stringify(r.out)})`);
    } catch {
      notes.push(`could not parse RFC probe output: ${res.stdout.slice(-200)}`);
    }
  }

  const pass = parseUnchanged && parseTestUnchanged && !wroteStepOne && rfcOk;
  if (pass) notes.push('step 1 untouched (state + tools), stringifier RFC-4180 correct');
  return { pass, notes };
}
