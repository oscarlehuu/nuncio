import { Controller, Get, Param, Query } from '@nestjs/common';
import { ObservabilityService } from './observability.service';
import type { RollupDimension } from './observability.types';

@Controller('observability')
export class ObservabilityController {
  constructor(private readonly observability: ObservabilityService) {}

  @Get('summary')
  summary(@Query('from') from?: string, @Query('to') to?: string) {
    return this.observability.summary(from, to);
  }

  @Get('sessions/:id')
  session(
    @Param('id') id: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.observability.session(id, from, to);
  }

  @Get('rollups')
  rollups(
    @Query('dimension') dimension?: RollupDimension,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.observability.rollups(dimension, from, to);
  }

  @Get('timeline')
  timeline(
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('before') before?: string,
    @Query('limit') limit?: string,
    @Query('projectPath') projectPath?: string,
    @Query('provider') provider?: string,
  ) {
    return this.observability.timeline({ from, to, before, limit, projectPath, provider }).entries;
  }
}

@Controller('timeline')
export class TimelineController {
  constructor(private readonly observability: ObservabilityService) {}

  @Get()
  timeline(
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('before') before?: string,
    @Query('limit') limit?: string,
    @Query('projectPath') projectPath?: string,
    @Query('provider') provider?: string,
  ) {
    return this.observability.timeline({ from, to, before, limit, projectPath, provider });
  }
}
