import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ForgesService } from '../forges.service';

interface OpenPullRequestBody {
  title?: string;
  body?: string;
  draft?: boolean;
  base?: string;
}

@Controller('sessions/:id/forge')
export class ForgesController {
  constructor(private readonly forges: ForgesService) {}

  @Post('pull-request')
  openPullRequest(@Param('id') id: string, @Body() body: OpenPullRequestBody) {
    return this.forges.openPullRequestForSession(id, body ?? {});
  }

  @Get('pull-request')
  getPullRequest(@Param('id') id: string) {
    return this.forges.getPullRequestForSession(id);
  }

  @Post('pull-request/comment')
  async addComment(@Param('id') id: string, @Body() body: { body: string }) {
    await this.forges.addCommentForSession(id, body.body);
    return { ok: true };
  }
}
