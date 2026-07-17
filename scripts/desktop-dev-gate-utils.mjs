/**
 * Pure decision logic for the gated dev desktop-release channel.
 *
 * Properties upheld:
 *   - Publish only when every required check concluded success on the exact commit.
 *   - Exactly once: a commit with any dev release (draft = building, or published)
 *     is never rebuilt, so re-runs and the two-gates-before-first-publish race are no-ops.
 *   - Never drop the last green commit: publish on any all-green, unshipped commit —
 *     no "who finished last" timestamp race that a tie could deadlock.
 *   - Never go backward: never publish a commit that is behind the last shipped commit,
 *     so a late green on an old commit can't auto-update dev apps to older code.
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

function tagOf(rel) {
  return rel.tag_name ?? rel.tagName ?? '';
}
function isDraftRelease(rel) {
  return rel.draft ?? rel.isDraft ?? false;
}
function createdAtOf(rel) {
  return rel.created_at ?? rel.createdAt ?? rel.published_at ?? rel.publishedAt ?? '';
}

/**
 * Commit SHAs of EVERY dev release, draft or published. Drafts are included so a
 * build already in flight for a commit counts as "handled" — the gate and the
 * post-slot re-check both use this to stay exactly-once.
 * @param {Array<object>} releases
 * @returns {string[]}
 */
export function devReleaseShas(releases) {
  const shas = [];
  for (const rel of releases ?? []) {
    if (!isDevTag(tagOf(rel))) continue;
    const sha = commitFromReleaseBody(rel.body);
    if (sha) shas.push(sha);
  }
  return shas;
}

/**
 * The commit of the most recently PUBLISHED (non-draft) dev release — the dev-channel
 * head a new publish must not fall behind. Newest by created_at (drafts don't count as
 * shipped; a stuck draft must never freeze the channel head).
 * @param {Array<object>} releases
 * @returns {string|null}
 */
export function latestShippedSha(releases) {
  const published = (releases ?? [])
    .filter((rel) => !isDraftRelease(rel) && isDevTag(tagOf(rel)) && commitFromReleaseBody(rel.body))
    .sort((a, b) => String(createdAtOf(b)).localeCompare(String(createdAtOf(a))));
  return published.length ? commitFromReleaseBody(published[0].body) : null;
}

/**
 * Decide whether the dev channel should publish a build for `sha`.
 *
 * @param {object} p
 * @param {Array<{ workflow: string, conclusion: string|null }>} p.requiredRuns
 *        one entry per required workflow at this commit (conclusion null = no run yet).
 * @param {string[]} p.releasedShas  commit SHAs with a dev release already (draft or published).
 * @param {string|null} p.lastShippedSha  commit of the newest published dev release, or null.
 * @param {boolean} p.aheadOfLastShipped  whether `sha` is at/ahead of `lastShippedSha` (IO-computed).
 * @param {string} p.sha
 * @returns {{ publish: boolean, reason: string }}
 */
export function decideDevPublish({ requiredRuns, releasedShas, lastShippedSha, aheadOfLastShipped, sha }) {
  if (!Array.isArray(requiredRuns) || requiredRuns.length === 0) {
    return { publish: false, reason: 'no required checks resolved' };
  }
  const notGreen = requiredRuns.filter((run) => run.conclusion !== 'success');
  if (notGreen.length > 0) {
    const detail = notGreen.map((run) => `${run.workflow}=${run.conclusion ?? 'pending'}`).join(', ');
    return { publish: false, reason: `required checks not all green (${detail})` };
  }
  const target = (sha ?? '').toLowerCase();
  if ((releasedShas ?? []).map((s) => s.toLowerCase()).includes(target)) {
    return { publish: false, reason: `dev release already exists for ${sha}` };
  }
  if (lastShippedSha && lastShippedSha.toLowerCase() !== target && !aheadOfLastShipped) {
    return {
      publish: false,
      reason: `${sha} is behind the last shipped dev commit ${lastShippedSha} — refusing to go backward`,
    };
  }
  return { publish: true, reason: 'every required check is green, commit unshipped and not behind the dev head' };
}

/**
 * Retry an async lookup with exponential backoff. A GitHub API hiccup must never be
 * mistaken for a definitive answer — on persistent failure the caller FAILS the job
 * (retryable) rather than silently holding, so a green commit is never dropped.
 *
 * @template T
 * @param {() => Promise<T> | T} fn
 * @param {{ attempts?: number, baseDelayMs?: number, sleep?: (ms: number) => Promise<void> }} [opts]
 * @returns {Promise<T>}
 */
export async function withRetry(fn, opts = {}) {
  const attempts = opts.attempts ?? 3;
  const baseDelayMs = opts.baseDelayMs ?? 500;
  const sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  let lastErr;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < attempts) await sleep(baseDelayMs * 2 ** (attempt - 1));
    }
  }
  throw lastErr;
}
