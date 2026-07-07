// Hidden layer for review-diff-findings: a read-only review. (a) neither branch's
// tracked code changed — the review must touch no code (reviews/ is untracked and
// exempt); (b) reviews/findings.json validates against the exact schema
// [{file, line, summary, severity in high|medium|low}]; (c) planted-bug scoring —
// a bug counts found when a finding's file matches and its line is within +-5 of
// the planted line; PASS needs >= 2/3; (d) precision guard: <= 6 findings total,
// so a shotgun that happens to cover the plants does not pass.
import { readWorktree, git } from './lib/check-helpers.mjs';
import { PLANTED_BUGS, PINNED_SHAS } from '../fixtures/ts-lib-planted-bugs/setup.mjs';

const MAX_FINDINGS = 6;
const LINE_TOLERANCE = 5;
const SEVERITIES = new Set(['high', 'medium', 'low']);

// The review must change no committed CODE on either branch. Two signals:
//   - the working tree has no uncommitted change to a tracked file (reviews/ is
//     untracked and exempt), so nothing was edited-in-place;
//   - each branch tip is byte-EXACTLY the pinned deterministic SHA. Pinning the
//     SHA (not just the commit count) catches `git commit --amend`, which keeps
//     the count the same but rewrites the tip. This exact match is the primary
//     integrity anchor for the read-only contract.
// (Comparing the worktree against the *other* branch is meaningless — that diff
// IS the code under review.)
function noCodeChanged(dir) {
  const porcelain = git(dir, ['status', '--porcelain'])
    .stdout.split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    // Drop the untracked reviews/ deliverable.
    .filter((line) => !/\breviews\//.test(line));
  if (porcelain.length > 0) return { ok: false, why: `uncommitted change(s): ${porcelain.join(', ')}` };

  for (const [branch, sha] of Object.entries(PINNED_SHAS)) {
    const tip = git(dir, ['rev-parse', branch]).stdout.trim();
    if (tip !== sha) {
      return { ok: false, why: `${branch} tip ${tip.slice(0, 8)} != pinned ${sha.slice(0, 8)} (reviewer amended or committed)` };
    }
  }
  return { ok: true };
}

function validFinding(f) {
  return (
    f && typeof f === 'object' &&
    typeof f.file === 'string' &&
    Number.isInteger(f.line) &&
    typeof f.summary === 'string' &&
    SEVERITIES.has(f.severity) &&
    Object.keys(f).every((k) => ['file', 'line', 'summary', 'severity'].includes(k))
  );
}

export default function check({ fixtureDir }) {
  const notes = [];

  const code = noCodeChanged(fixtureDir);
  if (!code.ok) notes.push(`review touched code — ${code.why}`);

  const raw = readWorktree(fixtureDir, 'reviews/findings.json');
  if (raw === null) return { pass: false, notes: [...notes, 'reviews/findings.json not found'] };

  let findings;
  try {
    findings = JSON.parse(raw);
  } catch (err) {
    return { pass: false, notes: [...notes, `reviews/findings.json is not valid JSON: ${err.message}`] };
  }
  if (!Array.isArray(findings) || !findings.every(validFinding)) {
    return { pass: false, notes: [...notes, 'findings do not match [{file, line, summary, severity in high|medium|low}]'] };
  }

  const withinPrecision = findings.length <= MAX_FINDINGS;
  if (!withinPrecision) notes.push(`too many findings: ${findings.length} (max ${MAX_FINDINGS} — precision guard)`);

  const foundBugs = PLANTED_BUGS.filter((bug) =>
    findings.some((f) => f.file === bug.file && Math.abs(f.line - bug.line) <= LINE_TOLERANCE),
  );
  const enough = foundBugs.length >= 2;
  notes.push(`found ${foundBugs.length}/${PLANTED_BUGS.length} planted bugs${foundBugs.length === PLANTED_BUGS.length ? ' (perfect)' : ''}`);
  if (!enough) notes.push('fewer than 2/3 planted bugs found');

  const pass = code.ok && withinPrecision && enough;
  if (pass) notes.push('read-only review with >= 2/3 planted bugs and precise findings');
  return { pass, notes };
}
