/** @typedef {'patch' | 'minor' | 'major'} BumpType */

export const BUMP_TYPES = /** @type {const} */ (['patch', 'minor', 'major']);

const USER_FACING_PREFIXES = [
  'apps/web/src/',
  'apps/server/src/',
  'apps/landing/src/',
];

const SPEC_SUFFIXES = ['.spec.ts', '.spec.tsx', '.test.ts', '.test.tsx'];

/**
 * @param {string} filePath
 */
export function isUserFacingPath(filePath) {
  if (filePath === 'mockup.html') return true;
  if (!USER_FACING_PREFIXES.some((prefix) => filePath.startsWith(prefix))) {
    return false;
  }
  return !SPEC_SUFFIXES.some((suffix) => filePath.endsWith(suffix));
}

/**
 * @param {string[]} changedFiles
 */
export function hasChangesetInDiff(changedFiles) {
  return changedFiles.some(
    (file) => file.startsWith('.changeset/') && file.endsWith('.md') && file !== '.changeset/README.md',
  );
}

/**
 * @param {string[]} changedFiles
 * @param {{ skip?: boolean }} [opts]
 */
export function shouldRequireChangeset(changedFiles, opts = {}) {
  if (opts.skip) return false;
  const touchesUserFacing = changedFiles.some(isUserFacingPath);
  if (!touchesUserFacing) return false;
  return !hasChangesetInDiff(changedFiles);
}

/**
 * @param {BumpType} bump
 * @param {string} summary
 */
export function formatChangeset(bump, summary) {
  const trimmed = summary.trim();
  if (!trimmed) {
    throw new Error('changeset summary must not be empty');
  }
  return `---\n"nuncio": ${bump}\n---\n\n${trimmed}\n`;
}

/**
 * @param {string} summary
 */
export function slugFromSummary(summary) {
  const slug = summary
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug || 'change';
}

/**
 * @param {unknown} bump
 * @returns {bump is BumpType}
 */
export function isValidBump(bump) {
  return typeof bump === 'string' && BUMP_TYPES.includes(/** @type {BumpType} */ (bump));
}
