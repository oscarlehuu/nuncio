// Hidden layer for scoped-diff-budget: (a) the working-tree diff vs HEAD sums to
// at most 5 changed lines (added + removed, per numstat); (b) no whitespace-only
// churn — the set of files changed under `git diff` must equal the set under
// `git diff -w` (if a file appears only without -w, its change was pure
// whitespace, i.e. reformatting).
import { diffLineBudget, git } from './lib/check-helpers.mjs';

const BUDGET = 5;

function changedFileSet(dir, extraArgs = []) {
  const res = git(dir, ['diff', 'HEAD', '--name-only', ...extraArgs]);
  return new Set(res.stdout.split('\n').map((s) => s.trim()).filter(Boolean));
}

export default function check({ fixtureDir }) {
  const notes = [];

  const budget = diffLineBudget(fixtureDir);
  const withinBudget = budget <= BUDGET;
  if (!withinBudget) notes.push(`diff budget exceeded: ${budget} changed lines (max ${BUDGET})`);

  const full = changedFileSet(fixtureDir);
  const ignoreWs = changedFileSet(fixtureDir, ['-w']);
  // Any file that changed with -w removed = pure whitespace churn.
  const wsOnly = [...full].filter((f) => !ignoreWs.has(f));
  const noWhitespaceChurn = wsOnly.length === 0;
  if (!noWhitespaceChurn) notes.push(`whitespace-only churn in: ${wsOnly.join(', ')}`);

  const pass = withinBudget && noWhitespaceChurn;
  if (pass) notes.push(`diff is ${budget} lines, no whitespace churn`);
  return { pass, notes };
}
