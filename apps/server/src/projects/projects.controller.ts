import { BadRequestException, Body, Controller, Delete, Get, NotFoundException, Put, Query } from '@nestjs/common';
import { ProjectsRepository } from './projects.repository';
import type { UpsertProjectDto } from './projects.types';

/**
 * Per-project CONFIG surface (rung 2). Lives under /projects/config to sit beside
 * the git module's /projects (picker/branches) without colliding. Auth is the
 * global AuthGuard (loopback trusted, remote token/whois) — nothing extra here.
 */
@Controller('projects/config')
export class ProjectsController {
  constructor(private readonly projects: ProjectsRepository) {}

  @Get()
  get(@Query('path') path?: string) {
    if (path === undefined) {
      return { items: this.projects.list() };
    }
    const trimmed = path.trim();
    if (!trimmed) throw new BadRequestException('path query parameter is required');
    const project = this.projects.findByPath(trimmed);
    if (!project) throw new NotFoundException(`No project config for ${trimmed}`);
    return project;
  }

  @Put()
  upsert(@Body() body: UpsertProjectDto) {
    if (!body?.path || !body.path.trim()) {
      throw new BadRequestException('path is required');
    }
    // Repository validates enum / rounds and applies patch semantics.
    return this.projects.upsert(body);
  }

  @Delete()
  remove(@Query('path') path?: string) {
    const trimmed = path?.trim();
    if (!trimmed) throw new BadRequestException('path query parameter is required');
    this.projects.delete(trimmed);
    return { ok: true };
  }
}
