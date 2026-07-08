import { Controller, Get, Param, Query } from '@nestjs/common';
import { ObservabilityService } from './observability.service';
import type { RollupDimension } from './observability.types';

@Controller('observability')
export class ObservabilityController {
  constructor(private readonly observability: ObservabilityService) {}

  @Get('summary')
  summary(@Query('from') _from?: string, @Query('to') _to?: string) {
    return this.observability.summary();
  }

  @Get('sessions/:id')
  session(
    @Param('id') id: string,
    @Query('from') _from?: string,
    @Query('to') _to?: string,
  ) {
    return this.observability.session(id);
  }

  @Get('rollups')
  rollups(
    @Query('dimension') _dimension?: RollupDimension,
    @Query('from') _from?: string,
    @Query('to') _to?: string,
  ) {
    return this.observability.rollups();
  }

  @Get('timeline')
  timeline(
    @Query('from') _from?: string,
    @Query('to') _to?: string,
    @Query('projectPath') _projectPath?: string,
    @Query('provider') _provider?: string,
  ) {
    return this.observability.timeline();
  }
}
