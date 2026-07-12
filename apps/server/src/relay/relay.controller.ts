import { Controller, Get } from '@nestjs/common';
import { RelayHealthService } from './relay-health.service';
import type { RelayHealthDto } from './relay.types';

@Controller('relay')
export class RelayController {
  constructor(private readonly health: RelayHealthService) {}

  @Get('health')
  getHealth(): Promise<RelayHealthDto> {
    return this.health.probeAll();
  }
}
