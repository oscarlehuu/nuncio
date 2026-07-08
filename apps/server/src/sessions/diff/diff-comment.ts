import { BadRequestException } from '@nestjs/common';
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
 * Rejects an empty comment at the boundary.
 */
export function buildDiffCommentSteer(input: DiffCommentInput): string {
  const comment = input.comment?.trim() ?? '';
  if (!comment) throw new BadRequestException('comment is required');

  const path = input.path.trim();
  const range = input.startLine === input.endLine ? `${input.startLine}` : `${input.startLine}-${input.endLine}`;
  const hunk = capHunk(input.hunk ?? '');

  return `Re: ${path}:${range}\n\n\`\`\`diff\n${hunk}\n\`\`\`\n\n${comment}`;
}

function capHunk(hunk: string): string {
  if (hunk.length <= MAX_STEER_HUNK_CHARS) return hunk.trimEnd();
  return `${hunk.slice(0, MAX_STEER_HUNK_CHARS).trimEnd()}\n... truncated ...`;
}
