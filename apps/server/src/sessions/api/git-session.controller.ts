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

  @Get('sync')
  sync(@Param('id') id: string) {
    const session = this.sessions.get(id);
    if (!session) throw new NotFoundException('Session not found');
    const path = session.worktreePath ?? session.workspace ?? session.projectPath;
    if (!path) {
      throw new BadRequestException('Session has no git working directory');
    }
    return this.git.branchSync(path, { fallbackBase: session.baseBranch });
  }

  @Get('unpushed')
  unpushed(@Param('id') id: string) {
    const session = this.sessions.get(id);
    if (!session) throw new NotFoundException('Session not found');
    const path = session.worktreePath ?? session.workspace ?? session.projectPath;
    if (!path) {
      throw new BadRequestException('Session has no git working directory');
    }
    return this.git.unpushedCommits(path, { fallbackBase: session.baseBranch });
  }

  @Get('diff')
  diff(
    @Param('id') id: string,
    @Query('staged') staged?: string,
    @Query('base') base?: string,
    @Query('path') path?: string,
  ) {
    return this.git.diff(this.requireSessionGitDir(id), {
      staged: staged === '1' || staged === 'true',
      base: base?.trim() || undefined,
      path,
    });
  }

  @Get('commits/:sha/diff')
  commitDiff(@Param('id') id: string, @Param('sha') sha: string) {
    return this.git.commitDiff(this.requireSessionGitDir(id), sha);
  }

  @Get('stash')
  stash(@Param('id') id: string) {
    return this.git.stashList(this.requireSessionGitDir(id));
  }

  @Get('blame')
  blame(@Param('id') id: string, @Query('path') path?: string) {
    if (!path?.trim()) {
      throw new BadRequestException('path is required');
    }
    return this.git.blame(this.requireSessionGitDir(id), path);
  }

  @Get('history')
  history(@Param('id') id: string, @Query('limit') limit?: string) {
    const parsed = limit ? Number(limit) : undefined;
    return this.git.history(this.requireSessionGitDir(id), {
      limit: Number.isFinite(parsed) ? parsed : undefined,
    });
  }

  @Post('pull')
  pull(@Param('id') id: string) {
    return this.git.pull(this.requireSessionGitDir(id));
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

    const localBranch = (await this.git.status(path)).branch;
    if (!localBranch || localBranch === 'HEAD') {
      throw new BadRequestException('Session has no pushable branch');
    }
    const adoptedPullRequest =
      session.forgeProvider !== null &&
      session.pullRequestNumber !== null &&
      session.baseBranch ===
        `refs/nuncio/pull-requests/${session.forgeProvider}/${session.pullRequestNumber}`;
    return this.git.push(path, localBranch, {
      force: body?.force === true,
      ...(adoptedPullRequest && session.branch ? { remoteBranch: session.branch } : {}),
    });
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
