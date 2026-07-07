import { Controller, Get, Param, Post } from '@nestjs/common';
import { AttentionService } from './attention.service';

/**
 * Attention queue REST surface (rung 3, sub-phase A). Phone-first, UI-ready
 * shapes so the iPhone inbox renders directly. Auth is the global AuthGuard.
 *
 *   GET  /attention          → { items: ranked[], counts: {total, unacked, bySeverity} }
 *   GET  /attention/counts   → the badge counts alone (cheap poll / badge refresh)
 *   POST /attention/:id/ack  → ack ("seen"): mutes the badge, item stays open
 *   POST /attention/:id/resolve → manual resolve (founder override)
 */
@Controller('attention')
export class AttentionController {
  constructor(private readonly attention: AttentionService) {}

  @Get()
  list() {
    return this.attention.list();
  }

  // Declared BEFORE ':id' routes so 'counts' is not captured as an item id.
  @Get('counts')
  counts() {
    return this.attention.counts();
  }

  @Post(':id/ack')
  ack(@Param('id') id: string) {
    return this.attention.acknowledge(id);
  }

  @Post(':id/resolve')
  resolve(@Param('id') id: string) {
    return this.attention.resolve(id);
  }
}
