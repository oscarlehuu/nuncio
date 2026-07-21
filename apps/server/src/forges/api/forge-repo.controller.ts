import { BadRequestException, Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ForgeRepoService } from '../forges-repo.service';
import type {
  ForgeMergeMethod,
  ForgeReviewEvent,
  ForgeStateFilter,
} from '../forges.types';

interface MergeBody {
  method?: ForgeMergeMethod;
  deleteSourceBranch?: boolean;
  mergeWhenChecksPass?: boolean;
  commitTitle?: string;
  commitMessage?: string;
}

/**
 * Repo-scoped forge routes. A project is identified by `?path=` (absolute
 * path inside the repo), matching the /api/projects/branches convention.
 */
@Controller('forge')
export class ForgeRepoController {
  constructor(private readonly forge: ForgeRepoService) {}

  @Get('capabilities')
  capabilities(@Query('path') path: string) {
    return this.forge.capabilities(path);
  }

  @Get('pulls')
  listPulls(@Query('path') path: string, @Query('state') state?: string) {
    return this.forge.listPullRequests(path, parseStateFilter(state));
  }

  @Get('pulls/:number')
  getPull(@Query('path') path: string, @Param('number') number: string) {
    return this.forge.getPullRequestDetail(path, parseNumber(number));
  }

  @Get('pulls/:number/files')
  listPullFiles(@Query('path') path: string, @Param('number') number: string) {
    return this.forge.listPullRequestFiles(path, parseNumber(number));
  }

  @Get('pulls/:number/threads')
  listThreads(@Query('path') path: string, @Param('number') number: string) {
    return this.forge.listReviewThreads(path, parseNumber(number));
  }

  @Get('pulls/:number/comments')
  listPullComments(@Query('path') path: string, @Param('number') number: string) {
    return this.forge.listPullRequestComments(path, parseNumber(number));
  }

  @Post('pulls/:number/threads/:threadId/reply')
  async replyToThread(
    @Query('path') path: string,
    @Param('number') number: string,
    @Param('threadId') threadId: string,
    @Body() body: { body?: string },
  ) {
    // :threadId here is the thread's replyTargetId (see ForgeReviewThread).
    await this.forge.replyToThread(path, parseNumber(number), threadId, body?.body ?? '');
    return { ok: true };
  }

  @Post('pulls/:number/threads/:threadId/resolve')
  async resolveThread(
    @Query('path') path: string,
    @Param('number') number: string,
    @Param('threadId') threadId: string,
    @Body() body: { resolved?: boolean },
  ) {
    await this.forge.resolveThread(path, parseNumber(number), threadId, body?.resolved ?? true);
    return { ok: true };
  }

  @Post('pulls/:number/review')
  async submitReview(
    @Query('path') path: string,
    @Param('number') number: string,
    @Body() body: { event?: string; body?: string },
  ) {
    await this.forge.submitReview(path, parseNumber(number), {
      event: parseReviewEvent(body?.event),
      body: body?.body,
    });
    return { ok: true };
  }

  @Post('pulls/:number/comment')
  async addPullComment(
    @Query('path') path: string,
    @Param('number') number: string,
    @Body() body: { body?: string },
  ) {
    await this.forge.addPullRequestComment(path, parseNumber(number), body?.body ?? '');
    return { ok: true };
  }

  @Post('pulls/:number/merge')
  mergePull(
    @Query('path') path: string,
    @Param('number') number: string,
    @Body() body: MergeBody,
  ) {
    return this.forge.mergePullRequest(path, parseNumber(number), {
      method: parseMergeMethod(body?.method),
      deleteSourceBranch: body?.deleteSourceBranch,
      mergeWhenChecksPass: body?.mergeWhenChecksPass,
      commitTitle: body?.commitTitle,
      commitMessage: body?.commitMessage,
    });
  }

  @Post('pulls/:number/state')
  async updatePullState(
    @Query('path') path: string,
    @Param('number') number: string,
    @Body() body: { state?: string },
  ) {
    await this.forge.updatePullRequestState(path, parseNumber(number), parseOpenClosed(body?.state));
    return { ok: true };
  }

  @Post('pulls/:number/update-branch')
  async updateBranch(@Query('path') path: string, @Param('number') number: string) {
    await this.forge.updateBranch(path, parseNumber(number));
    return { ok: true };
  }

  @Get('runs')
  listRuns(@Query('path') path: string, @Query('branch') branch?: string) {
    return this.forge.listWorkflowRuns(path, branch?.trim() || undefined);
  }

  @Get('runs/:id/jobs')
  listRunJobs(@Query('path') path: string, @Param('id') id: string) {
    return this.forge.getWorkflowRunJobs(path, parseNumber(id));
  }

  @Post('runs/:id/rerun')
  async rerunRun(
    @Query('path') path: string,
    @Param('id') id: string,
    @Body() body: { failedOnly?: boolean },
  ) {
    await this.forge.rerunWorkflowRun(path, parseNumber(id), body?.failedOnly);
    return { ok: true };
  }

  @Post('runs/:id/cancel')
  async cancelRun(@Query('path') path: string, @Param('id') id: string) {
    await this.forge.cancelWorkflowRun(path, parseNumber(id));
    return { ok: true };
  }

  @Get('jobs/:id/log')
  getJobLog(@Query('path') path: string, @Param('id') id: string) {
    return this.forge.getJobLog(path, parseNumber(id));
  }

  @Get('issues')
  listIssues(@Query('path') path: string, @Query('state') state?: string) {
    return this.forge.listIssues(path, parseStateFilter(state));
  }

  @Get('issues/:number')
  getIssue(@Query('path') path: string, @Param('number') number: string) {
    return this.forge.getIssue(path, parseNumber(number));
  }

  @Post('issues/:number/comment')
  async addIssueComment(
    @Query('path') path: string,
    @Param('number') number: string,
    @Body() body: { body?: string },
  ) {
    await this.forge.addIssueComment(path, parseNumber(number), body?.body ?? '');
    return { ok: true };
  }

  @Post('issues/:number/state')
  async updateIssueState(
    @Query('path') path: string,
    @Param('number') number: string,
    @Body() body: { state?: string },
  ) {
    await this.forge.updateIssueState(path, parseNumber(number), parseOpenClosed(body?.state));
    return { ok: true };
  }

  @Post('issues')
  createIssue(
    @Query('path') path: string,
    @Body() body: { title?: string; body?: string; labels?: string[] },
  ) {
    return this.forge.createIssue(path, {
      title: body?.title ?? '',
      body: body?.body ?? '',
      labels: body?.labels,
    });
  }
}

function parseNumber(raw: string): number {
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value <= 0) {
    throw new BadRequestException(`Invalid number: ${raw}`);
  }
  return value;
}

function parseStateFilter(raw: string | undefined): ForgeStateFilter {
  if (!raw?.trim()) return 'open';
  if (raw === 'open' || raw === 'closed' || raw === 'all') return raw;
  throw new BadRequestException(`Invalid state filter: ${raw}`);
}

function parseOpenClosed(raw: string | undefined): 'open' | 'closed' {
  if (raw === 'open' || raw === 'closed') return raw;
  throw new BadRequestException(`Invalid state: ${raw ?? '(missing)'}`);
}

function parseReviewEvent(raw: string | undefined): ForgeReviewEvent {
  if (raw === 'approve' || raw === 'request_changes' || raw === 'comment') return raw;
  throw new BadRequestException(`Invalid review event: ${raw ?? '(missing)'}`);
}

function parseMergeMethod(raw: string | undefined): ForgeMergeMethod {
  if (raw === 'merge' || raw === 'squash' || raw === 'rebase') return raw;
  throw new BadRequestException(`Invalid merge method: ${raw ?? '(missing)'}`);
}
