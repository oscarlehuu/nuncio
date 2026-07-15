// Pure helpers for the knip dead-code gate (see check-dead-code.mjs).
// Keys are `${category}:${file}:${symbol}` — no line/col, so moving code
// within a file does not churn the committed baseline.

// Issue categories whose entries are arrays of `{ name }` on each knip issue.
const NAMED_CATEGORIES = [
  'dependencies',
  'devDependencies',
  'optionalPeerDependencies',
  'unlisted',
  'binaries',
  'unresolved',
  'exports',
  'types',
  'namespaceMembers',
  'catalog',
];

/**
 * Flatten a knip `--reporter json` report into a sorted, deduped list of
 * stable issue keys.
 * @param {{ issues?: Array<Record<string, unknown>> }} report
 * @returns {string[]}
 */
export function issueKeysFromReport(report) {
  const keys = new Set();
  for (const issue of report.issues ?? []) {
    const file = issue.file;
    for (const entry of issue.files ?? []) {
      keys.add(`unused-file:${entry.name}`);
    }
    for (const category of NAMED_CATEGORIES) {
      for (const entry of asEntries(issue[category])) {
        keys.add(`${category}:${file}:${entry.name}`);
      }
    }
    // enumMembers is keyed by enum name → members.
    for (const [parent, members] of asKeyedGroups(issue.enumMembers)) {
      for (const member of members) {
        keys.add(`enumMembers:${file}:${parent}.${member.name}`);
      }
    }
    for (const group of issue.duplicates ?? []) {
      const names = group.map((entry) => entry.name).join('|');
      keys.add(`duplicates:${file}:${names}`);
    }
  }
  return [...keys].sort();
}

/** Normalize a category that is an array of `{ name }` (or absent). */
function asEntries(value) {
  return Array.isArray(value) ? value : [];
}

/** Normalize a `{ Parent: [{ name }] }` map (knip emits `[]` when empty). */
function asKeyedGroups(value) {
  if (!value || Array.isArray(value)) return [];
  return Object.entries(value);
}

/**
 * Compare current issue keys against the committed baseline.
 * @param {string[]} current
 * @param {string[]} baseline
 * @returns {{ added: string[], fixed: string[] }}
 */
export function diffIssueKeys(current, baseline) {
  const baselineSet = new Set(baseline);
  const currentSet = new Set(current);
  return {
    added: current.filter((key) => !baselineSet.has(key)),
    fixed: baseline.filter((key) => !currentSet.has(key)),
  };
}
