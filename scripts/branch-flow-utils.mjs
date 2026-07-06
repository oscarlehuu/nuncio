/** @typedef {{ ok: true } | { ok: false, reason: string }} BranchFlowResult */

/**
 * @param {string} head
 */
export function isChangesetReleaseBranch(head) {
  return head === 'changeset-release/main' || head.startsWith('changeset-release/');
}

/**
 * Enforce the two-branch merge graph:
 *   <type>/<slug> (worktree from dev)  →  dev  →  main   (promotion)
 *   changeset-release/*                →  main           (release bot)
 *   main                               →  dev            (sync-back after a release)
 *
 * `main` is the stable release branch and only accepts promotion from `dev`
 * or the Changesets release bot. Everything else integrates through `dev`.
 *
 * @param {string} base  PR target branch (e.g. main, dev)
 * @param {string} head  PR source branch (e.g. feat/steer-queue-ui)
 * @returns {BranchFlowResult}
 */
export function validateBranchFlow(base, head) {
  if (base === 'main') {
    if (head === 'dev' || isChangesetReleaseBranch(head)) {
      return { ok: true };
    }
    return {
      ok: false,
      reason: `main only accepts PRs from dev (promotion) or changeset-release/* (release bot). Got: ${head}`,
    };
  }

  // dev (and any other base) accepts feature branches and main sync-backs.
  return { ok: true };
}
