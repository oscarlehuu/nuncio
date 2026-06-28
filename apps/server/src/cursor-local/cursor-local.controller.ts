import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import { CursorLocalSessionsService } from './cursor-local-sessions.service';

@Controller('cursor')
export class CursorLocalController {
  constructor(private readonly localSessions: CursorLocalSessionsService) {}

  @Get('local-sessions')
  list(@Query('workspace') workspace?: string, @Query('limit') limit?: string) {
    const ws = workspace?.trim();
    if (!ws) throw new BadRequestException('workspace query param is required');
    const parsedLimit = limit ? Number(limit) : undefined;
    const safeLimit = parsedLimit && Number.isFinite(parsedLimit) ? parsedLimit : undefined;
    return {
      items: this.localSessions.listForWorkspace(ws, safeLimit),
    };
  }
}
