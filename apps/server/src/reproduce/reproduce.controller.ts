import { BadRequestException, Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ReproduceService } from './reproduce.service';

/**
 * Debug reproduction-gate REST surface. Phone-first, one-tap shapes.
 *
 *   GET  /reproduce?sessionId=…   → open (requested) gates for a session
 *   POST /reproduce/:id/logs      → append captured logs (body: { lines?: [], text? })
 *   POST /reproduce/:id/proceed   → resume with the collected logs → gate
 *   POST /reproduce/:id/mark-fixed→ resume to strip instrumentation → gate
 */
@Controller('reproduce')
export class ReproduceController {
  constructor(private readonly reproduce: ReproduceService) {}

  @Get()
  list(@Query('sessionId') sessionId?: string) {
    if (!sessionId?.trim()) throw new BadRequestException('sessionId is required');
    return this.reproduce.listForSession(sessionId.trim());
  }

  @Post(':id/logs')
  logs(@Param('id') id: string, @Body() body?: { lines?: unknown; text?: unknown }) {
    return this.reproduce.appendLogs(id, normalizeLogLines(body));
  }

  @Post(':id/proceed')
  proceed(@Param('id') id: string) {
    return this.reproduce.proceed(id);
  }

  @Post(':id/mark-fixed')
  markFixed(@Param('id') id: string) {
    return this.reproduce.markFixed(id);
  }
}

/** Accept either an explicit `lines` array or a pasted `text` blob (split on newlines). */
function normalizeLogLines(body?: { lines?: unknown; text?: unknown }): string[] {
  if (Array.isArray(body?.lines)) {
    return body!.lines.filter((line): line is string => typeof line === 'string');
  }
  if (typeof body?.text === 'string') {
    return body.text.split(/\r?\n/);
  }
  throw new BadRequestException('Provide log lines as { lines: string[] } or { text: string }.');
}
