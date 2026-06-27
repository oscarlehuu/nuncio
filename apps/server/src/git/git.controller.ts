import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import { GitService } from './git.service';

@Controller('projects')
export class GitController {
  constructor(private readonly git: GitService) {}

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
}
