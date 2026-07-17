/**
 * Pure decision logic for the gated dev desktop-release channel.
 *
 * Property to uphold: **publish exactly once, and never drop the last green commit.**
 *   - A dev prerelease publishes only when every required check concluded success
 *     on the exact commit.
 *   - Whichever required check finishes last is the first (often only) trigger to
 *     observe all-green, so it publishes — no "which finished last" timestamp race,
 *     no tie that can deadlock the publish.
 *   - A commit that already has a published dev release is never rebuilt, so a manual
 *     re-run of CI/smoke on a shipped commit is a no-op instead of a duplicate build.
 */

/** A dev prerelease tag looks like `v1.2.3-dev.45`. */
export function isDevTag(tag) {
  return /-dev\.\d+$/.test(tag ?? '');
}

/**
 * The commit a dev release was built from, read from the machine-readable marker
 * the build writes into the release notes (`commit: <sha>`), or null if absent.
 * @param {string|null|undefined} body
 * @returns {string|null}
 */
export function commitFromReleaseBody(body) {
  const match = /commit:\s*([0-9a-f]{7,40})\b/i.exec(body ?? '');
  return match ? match[1].toLowerCase() : null;
}

/**
 * Commit SHAs that already have a PUBLISHED (non-draft) dev prerelease. Drafts are
 * excluded: a draft is an in-flight or cancelled build, not a confirmed ship.
 * @param {Array<{ tag_name?: string, tagName?: string, draft?: boolean, isDraft?: boolean, body?: string }>} releases
 * @returns {string[]}
 */
export function publishedDevShas(releases) {
  const shas = [];
  for (const rel of releases ?? []) {
    const tag = rel.tag_name ?? rel.tagName ?? '';
    const draft = rel.draft ?? rel.isDraft ?? false;
    if (draft || !isDevTag(tag)) continue;
    const sha = commitFromReleaseBody(rel.body);
    if (sha) shas.push(sha);
  }
  return shas;
}

/**
 * Decide whether the dev channel should publish a build for `sha`.
 *
 * @param {object} p
 * @param {Array<{ workflow: string, conclusion: string|null }>} p.requiredRuns
 *        one entry per required workflow at this commit (conclusion null = no run yet).
 * @param {string[]} p.publishedShas  commit SHAs that already shipped a dev release.
 * @param {string} p.sha
 * @returns {{ publish: boolean, reason: string }}
 */
export function decideDevPublish({ requiredRuns, publishedShas, sha }) {
  if (!Array.isArray(requiredRuns) || requiredRuns.length === 0) {
    return { publish: false, reason: 'no required checks resolved' };
  }
  const notGreen = requiredRuns.filter((run) => run.conclusion !== 'success');
  if (notGreen.length > 0) {
    const detail = notGreen.map((run) => `${run.workflow}=${run.conclusion ?? 'pending'}`).join(', ');
    return { publish: false, reason: `required checks not all green (${detail})` };
  }
  const target = (sha ?? '').toLowerCase();
  if ((publishedShas ?? []).map((s) => s.toLowerCase()).includes(target)) {
    return { publish: false, reason: `dev release already shipped for ${sha}` };
  }
  return { publish: true, reason: 'every required check is green and this commit has not shipped' };
}
