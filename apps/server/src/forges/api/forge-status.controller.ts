import { Controller, Get, Param } from '@nestjs/common';
import { ForgesService } from '../forges.service';
import type { ForgeStatusDto } from '../forges.types';

@Controller('forges')
export class ForgeStatusController {
  constructor(private readonly forges: ForgesService) {}

  @Get()
  getStatus(): Promise<ForgeStatusDto[]> {
    return this.forges.listStatus();
  }

  /**
   * Repositories the authenticated user can clone (forge-aware project picker).
   * Unknown / unauthenticated / non-enumerable forge → 4xx (the UI shows the
   * reason disabled, never an auth prompt).
   */
  @Get(':id/repos')
  async listRepos(@Param('id') id: string) {
    return { items: await this.forges.listRepositories(id) };
  }
}
