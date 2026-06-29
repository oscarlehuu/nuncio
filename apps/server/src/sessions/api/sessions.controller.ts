import {
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import type { CreateSessionDto, HandoffSessionDto, SteerSessionDto } from '../domain/sessions.types';
import { SessionsService } from '../sessions.service';

@Controller('sessions')
export class SessionsController {
  constructor(private readonly sessions: SessionsService) {}

  @Get()
  list(@Query('includeArchived') includeArchived?: string) {
    return this.sessions.list(includeArchived === '1' || includeArchived === 'true');
  }

  @Post()
  create(@Body() body: CreateSessionDto) {
    if (!body?.prompt?.trim()) {
      return { error: 'prompt is required' };
    }
    return this.sessions.create({
      prompt: body.prompt.trim(),
      provider: body.provider,
      model: body.model,
      workspace: body.workspace,
      projectPath: body.projectPath,
      baseBranch: body.baseBranch,
    });
  }

  @Post('handoff')
  handoff(@Body() body: HandoffSessionDto) {
    return this.sessions.handoff(body);
  }

  @Get(':id/active-run')
  activeRun(@Param('id') id: string) {
    const session = this.sessions.get(id);
    if (!session) throw new NotFoundException('Session not found');
    return { active: this.sessions.isCursorCliActive(id) };
  }

  @Post(':id/refresh-transcript')
  refreshTranscript(@Param('id') id: string) {
    const session = this.sessions.get(id);
    if (!session) throw new NotFoundException('Session not found');
    return this.sessions.refreshTranscript(id);
  }

  @Get(':id')
  get(@Param('id') id: string) {
    const session = this.sessions.get(id);
    if (!session) throw new NotFoundException('Session not found');
    return session;
  }

  @Post(':id/steer')
  steer(@Param('id') id: string, @Body() body: SteerSessionDto) {
    return this.sessions.steer(id, body?.message ?? '', body?.forceResume);
  }

  @Post(':id/pause')
  pause(@Param('id') id: string) {
    return this.sessions.pause(id);
  }

  @Post(':id/archive')
  archive(@Param('id') id: string) {
    return this.sessions.archive(id);
  }

  @Post(':id/restore')
  restore(@Param('id') id: string) {
    return this.sessions.restore(id);
  }

  @Patch(':id')
  rename(@Param('id') id: string, @Body() body: { title?: string }) {
    if (!body?.title?.trim()) {
      return { error: 'title is required' };
    }
    return this.sessions.rename(id, body.title.trim());
  }

  @Delete(':id')
  delete(@Param('id') id: string) {
    this.sessions.delete(id);
    return { ok: true };
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
