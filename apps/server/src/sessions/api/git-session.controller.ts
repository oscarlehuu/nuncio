import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { GitService } from '../../git/git.service';
import { SessionsService } from '../sessions.service';

interface CommitBody {
  message?: string;
  stageAll?: boolean;
}

interface PushBody {
  force?: boolean;
}

@Controller('sessions/:id/git')
export class GitSessionController {
  constructor(
    private readonly sessions: SessionsService,
    private readonly git: GitService,
  ) {}

  @Get('status')
  status(@Param('id') id: string) {
    return this.git.status(this.requireSessionGitDir(id));
  }

  @Get('diff')
  diff(
    @Param('id') id: string,
    @Query('staged') staged?: string,
    @Query('base') base?: string,
  ) {
    return this.git.diff(this.requireSessionGitDir(id), {
      staged: staged === '1' || staged === 'true',
      base: base?.trim() || undefined,
    });
  }

  @Post('commit')
  async commit(@Param('id') id: string, @Body() body: CommitBody) {
    const path = this.requireSessionGitDir(id);
    const message = body?.message?.trim();
    if (!message) {
      throw new BadRequestException('message is required');
    }
    if (body?.stageAll !== false) {
      await this.git.stageAll(path);
    }
    return this.git.commit(path, message);
  }

  @Post('push')
  async push(@Param('id') id: string, @Body() body: PushBody) {
    const session = this.sessions.get(id);
    if (!session) throw new NotFoundException('Session not found');
    const path = session.worktreePath ?? session.workspace ?? session.projectPath;
    if (!path) {
      throw new BadRequestException('Session has no git working directory');
    }

    const branch = session.branch ?? (await this.git.status(path)).branch;
    if (!branch || branch === 'HEAD') {
      throw new BadRequestException('Session has no pushable branch');
    }
    return this.git.push(path, branch, { force: body?.force === true });
  }

  private requireSessionGitDir(id: string): string {
    const session = this.sessions.get(id);
    if (!session) throw new NotFoundException('Session not found');

    const path = session.worktreePath ?? session.workspace ?? session.projectPath;
    if (!path) {
      throw new BadRequestException('Session has no git working directory');
    }
    return path;
  }
}
