import { Controller, Get, Query } from '@nestjs/common';
import { DigestRepository } from './digest.repository';

/**
 * In-app digest view (rung 3 sub-phase B). Phone-first: returns the durable
 * last-built digest so the founder can read the morning/evening summary without
 * recomputing. Push is the pointer; this is the content.
 *
 *   GET /heartbeat/digest?slot=latest  → the most-recent sent digest (or null)
 *   GET /heartbeat/digest?slot=<key>   → a specific slot's digest
 */
@Controller('heartbeat')
export class HeartbeatController {
  constructor(private readonly digests: DigestRepository) {}

  @Get('digest')
  digest(@Query('slot') slot?: string) {
    if (!slot || slot === 'latest') return this.digests.latest();
    return this.digests.findBySlot(slot);
  }
}
