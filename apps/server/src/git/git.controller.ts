import { BadRequestException, Body, Controller, Get, Post, Query } from '@nestjs/common';
import { GitService } from './git.service';
import { RecentProjectsRepository } from './recent-projects.repository';

@Controller('projects')
export class GitController {
  constructor(
    private readonly git: GitService,
    private readonly recentProjects: RecentProjectsRepository,
  ) {}

  @Get()
  listProjects() {
    return this.git.listProjects();
  }

  @Get('branches')
  listBranches(@Query('path') path?: string) {
    const trimmed = path?.trim();
    if (!trimmed) {
      throw new BadRequestException('path query parameter is required');
    }
    return this.git.listBranches(trimmed);
  }

  @Get('recent')
  listRecent() {
    return { items: this.recentProjects.list() };
  }

  @Post('recent')
  async recordRecent(@Body() body: { path?: string }) {
    const trimmed = body.path?.trim();
    if (!trimmed) {
      throw new BadRequestException('path is required');
    }
    const repoRoot = await this.git.resolveRepoRoot(trimmed);
    return this.recentProjects.record(repoRoot);
  }
}
