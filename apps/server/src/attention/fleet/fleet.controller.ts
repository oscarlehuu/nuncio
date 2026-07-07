import { Controller, Get } from '@nestjs/common';
import { FleetService } from './fleet.service';

/**
 * Fleet home (rung 3, sub-phase C) — the founder's cockpit landing surface.
 * Phone-first: one ready-to-render row per project.
 *
 *   GET /fleet -> { items: FleetRow[] }  (ordered red first)
 */
@Controller('fleet')
export class FleetController {
  constructor(private readonly fleet: FleetService) {}

  @Get()
  async list() {
    return { items: await this.fleet.list() };
  }
}
