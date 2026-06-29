/** @typedef {{ ok: true } | { ok: false, reason: string }} BranchFlowResult */

/**
 * @param {string} head
 */
export function isCursorFeatureBranch(head) {
  return head.startsWith('cursor/');
}

/**
 * @param {string} head
 */
export function isPiFeatureBranch(head) {
  return head.startsWith('pi/');
}

/**
 * @param {string} head
 */
export function isCodexFeatureBranch(head) {
  return head.startsWith('codex/');
}

/**
 * @param {string} head
 */
export function isChangesetReleaseBranch(head) {
  return head === 'changeset-release/main' || head.startsWith('changeset-release/');
}

/**
 * Enforce the SDK lane merge graph:
 *   cursor/*  → cursor-sdk → main
 *   pi/*      → pi-sdk     → main
 *   codex/*   → codex-sdk  → main
 *   main      → cursor-sdk | pi-sdk | codex-sdk  (sync-back only)
 *
 * @param {string} base  PR target branch (e.g. main, cursor-sdk)
 * @param {string} head  PR source branch (e.g. cursor/feat-handoff)
 * @returns {BranchFlowResult}
 */
export function validateBranchFlow(base, head) {
  switch (base) {
    case 'cursor-sdk':
      if (isCursorFeatureBranch(head) || head === 'main') {
        return { ok: true };
      }
      return {
        ok: false,
        reason: `cursor-sdk only accepts PRs from cursor/* or main (sync-back). Got: ${head}`,
      };

    case 'pi-sdk':
      if (isPiFeatureBranch(head) || head === 'main') {
        return { ok: true };
      }
      return {
        ok: false,
        reason: `pi-sdk only accepts PRs from pi/* or main (sync-back). Got: ${head}`,
      };

    case 'codex-sdk':
      if (isCodexFeatureBranch(head) || head === 'main') {
        return { ok: true };
      }
      return {
        ok: false,
        reason: `codex-sdk only accepts PRs from codex/* or main (sync-back). Got: ${head}`,
      };

    case 'main':
      if (
        head === 'cursor-sdk' ||
        head === 'pi-sdk' ||
        head === 'codex-sdk' ||
        isChangesetReleaseBranch(head)
      ) {
        return { ok: true };
      }
      return {
        ok: false,
        reason:
          `main only accepts PRs from cursor-sdk, pi-sdk, codex-sdk, or changeset-release/* (release bot). Got: ${head}`,
      };

    default:
      return { ok: true };
  }
}
