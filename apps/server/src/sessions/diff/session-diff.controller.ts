import { BadRequestException, Body, Controller, Get, Param, Post } from '@nestjs/common';
import { SessionDiffService } from './session-diff.service';
import type { DiffCommentInput } from './session-diff.types';

/**
 * Diff review + comment-to-steer (rung 3, sub-phase D). Phone-first:
 *
 *   GET  /sessions/:id/diff          → structured, capped worktree SessionDiff
 *   POST /sessions/:id/diff/comment  → a hunk comment becomes a rung-1 steer
 *
 * The comment body carries file:line + the hunk text; the server builds the steer
 * message and rides the EXISTING steer path (running → queued).
 */
@Controller('sessions/:id/diff')
export class SessionDiffController {
  constructor(private readonly diffs: SessionDiffService) {}

  @Get()
  get(@Param('id') id: string) {
    return this.diffs.diff(id);
  }

  @Post('comment')
  comment(@Param('id') id: string, @Body() body: Partial<DiffCommentInput>) {
    if (!body?.path?.trim()) throw new BadRequestException('path is required');
    if (!body?.comment?.trim()) throw new BadRequestException('comment is required');
    return this.diffs.comment(id, {
      path: body.path,
      startLine: body.startLine ?? 0,
      endLine: body.endLine ?? 0,
      hunk: body.hunk ?? '',
      comment: body.comment,
    });
  }
}
