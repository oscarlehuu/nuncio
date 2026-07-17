import { BadRequestException, Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ChipsService } from './chips.service';

/**
 * Session-chip REST surface (spawn-task). Phone-first, one-tap shapes.
 *
 *   GET  /chips?sessionId=…    → open (proposed) chips for a source session
 *   POST /chips/:id/act        → spin the chip into a child session → { chip, session }
 *   POST /chips/:id/dismiss    → user dismiss (body: { reason? }) → chip
 */
@Controller('chips')
export class ChipsController {
  constructor(private readonly chips: ChipsService) {}

  @Get()
  list(@Query('sessionId') sessionId?: string) {
    if (!sessionId?.trim()) throw new BadRequestException('sessionId is required');
    return this.chips.listForSession(sessionId.trim());
  }

  @Post(':id/act')
  act(@Param('id') id: string) {
    return this.chips.act(id);
  }

  @Post(':id/dismiss')
  dismiss(@Param('id') id: string, @Body() body?: { reason?: string }) {
    const reason = typeof body?.reason === 'string' ? body.reason.trim() : '';
    return this.chips.dismiss(id, { by: 'user', ...(reason ? { reason } : {}) });
  }
}
