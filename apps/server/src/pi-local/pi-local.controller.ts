import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import { PiLocalSessionsService } from './pi-local-sessions.service';

@Controller('pi')
export class PiLocalController {
  constructor(private readonly localSessions: PiLocalSessionsService) {}

  @Get('local-sessions')
  async list(@Query('workspace') workspace?: string, @Query('limit') limit?: string) {
    const ws = workspace?.trim();
    if (!ws) throw new BadRequestException('workspace query param is required');
    const parsedLimit = limit ? Number(limit) : undefined;
    const safeLimit = parsedLimit && Number.isFinite(parsedLimit) ? parsedLimit : undefined;
    return {
      items: await this.localSessions.listForWorkspace(ws, safeLimit),
    };
  }
}
