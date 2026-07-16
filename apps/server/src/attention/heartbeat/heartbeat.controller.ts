import { Controller, Get, Query } from '@nestjs/common';
import { DigestRepository } from './digest.repository';
import { HeartbeatHealthRepository } from './heartbeat-health.repository';

/**
 * In-app digest view (rung 3 sub-phase B). Phone-first: returns the durable
 * last-built digest so the founder can read the morning/evening summary without
 * recomputing. Push is the pointer; this is the content.
 *
 *   GET /heartbeat/digest?slot=latest  → the most-recent sent digest (or null)
 *   GET /heartbeat/digest?slot=<key>   → a specific slot's digest
 *   GET /heartbeat/health              → last-run status of each system job
 */
@Controller('heartbeat')
export class HeartbeatController {
  constructor(
    private readonly digests: DigestRepository,
    private readonly health: HeartbeatHealthRepository,
  ) {}

  @Get('digest')
  digest(@Query('slot') slot?: string) {
    if (!slot || slot === 'latest') return this.digests.latest();
    return this.digests.findBySlot(slot);
  }

  /** Read-only heartbeat health for the Settings facts block. */
  @Get('health')
  healthReport() {
    return { items: this.health.list() };
  }
}
