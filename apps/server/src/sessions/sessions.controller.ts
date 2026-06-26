import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import type { CreateSessionDto } from './session.types';
import { SessionsService } from './sessions.service';

@Controller('sessions')
export class SessionsController {
  constructor(private readonly sessions: SessionsService) {}

  @Get()
  list() {
    return this.sessions.list();
  }

  @Post()
  create(@Body() body: CreateSessionDto) {
    if (!body?.prompt?.trim()) {
      return { error: 'prompt is required' };
    }
    return this.sessions.create({ prompt: body.prompt.trim(), model: body.model });
  }

  @Get(':id')
  get(@Param('id') id: string) {
    const session = this.sessions.get(id);
    if (!session) throw new NotFoundException('Session not found');
    return session;
  }

  @Get(':id/events')
  events(@Param('id') id: string, @Query('since') since?: string) {
    const session = this.sessions.get(id);
    if (!session) throw new NotFoundException('Session not found');
    const cursor = since ? Number(since) : 0;
    return this.sessions.getEvents(id, Number.isFinite(cursor) ? cursor : 0);
  }

  @Get(':id/stream')
  stream(
    @Param('id') id: string,
    @Query('since') since: string | undefined,
    @Res() res: Response,
  ) {
    const session = this.sessions.get(id);
    if (!session) throw new NotFoundException('Session not found');

    const cursor = since ? Number(since) : 0;
    const safeSince = Number.isFinite(cursor) ? cursor : 0;

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    for (const event of this.sessions.getEvents(id, safeSince)) {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    }

    const unsubscribe = this.sessions.subscribe(id, (event) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    });

    const heartbeat = setInterval(() => res.write(': ping\n\n'), 15000);
    res.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
      res.end();
    });
  }
}
