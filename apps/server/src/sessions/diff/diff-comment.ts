import type { DiffCommentInput } from './session-diff.types';

/** Cap the hunk text embedded in a steer message (a steer is a pointer, not a dump). */
export const MAX_STEER_HUNK_CHARS = 2000;

/**
 * Build the steer text for a diff-hunk comment (rung 3 sub-phase D). Pure. A
 * delimited block carrying file:line context + the (capped) hunk + the founder's
 * comment, which rides the EXISTING rung-1 steer path (running → queued):
 *
 *   Re: <path>:<startLine>-<endLine>
 *
 *   ```diff
 *   <hunk, capped with a truncation marker>
 *   ```
 *
 *   <comment>
 *
 * Rejects an empty comment at the boundary. RED until implemented — neutral TODO
 * so the reject/format tests don't false-green.
 */
export function buildDiffCommentSteer(input: DiffCommentInput): string {
  throw new Error('TODO: buildDiffCommentSteer not implemented');
  void input;
}
