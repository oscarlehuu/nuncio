import { Body, Controller, Post } from '@nestjs/common';
import { ForgesService } from '../forges.service';

interface CreateSessionFromPullRequestBody {
  path: string;
  number: number;
}

@Controller('sessions')
export class SessionsFromPullRequestController {
  constructor(private readonly forges: ForgesService) {}

  @Post('from-pr')
  create(@Body() body: CreateSessionFromPullRequestBody) {
    return this.forges.createSessionFromPullRequest(body?.path, body?.number);
  }
}
