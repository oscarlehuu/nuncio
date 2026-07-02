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
import type {
  CreateSessionDto,
  HandoffSessionDto,
  RespondInteractionDto,
  RespondProviderRequestDto,
  SetSessionModelDto,
  SteerSessionDto,
} from '../domain/sessions.types';
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
      modelOptions: body.modelOptions,
      attachments: body.attachments,
      workspace: body.workspace,
      projectPath: body.projectPath,
      baseBranch: body.baseBranch,
      useWorktree: body.useWorktree,
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
    return this.sessions.steer(id, body?.message ?? '', body?.forceResume, body?.attachments);
  }

  @Post(':id/interrupt')
  interrupt(@Param('id') id: string) {
    return this.sessions.interrupt(id);
  }

  @Patch(':id/model')
  setModel(@Param('id') id: string, @Body() body: SetSessionModelDto) {
    return this.sessions.setSessionModel(id, body?.model ?? '', body?.options);
  }

  @Post(':id/interactions/:requestId/respond')
  respondInteraction(
    @Param('id') id: string,
    @Param('requestId') requestId: string,
    @Body() body: RespondInteractionDto,
  ) {
    return this.sessions.respondInteraction(id, requestId, body);
  }

  @Post(':id/provider-requests/:requestId/respond')
  respondProviderRequest(
    @Param('id') id: string,
    @Param('requestId') requestId: string,
    @Body() body: RespondProviderRequestDto,
  ) {
    return this.sessions.respondProviderRequest(id, requestId, body?.decision);
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

  /**
   * One SSE connection carrying many sessions' events (grid view). Browsers cap
   * HTTP/1.1 connections per origin at ~6, so per-tile EventSources stall on
   * larger grids — this multiplexes them. `sessions` is `<id>:<since>,...`;
   * each event is the persisted row tagged with its sessionId.
   */
  @Get('stream/multi')
  streamMulti(@Query('sessions') sessions: string | undefined, @Res() res: Response) {
    const subs = (sessions ?? '')
      .split(',')
      .map((part) => {
        const [id, since] = part.split(':');
        const cursor = Number(since ?? '0');
        return { id: id?.trim() ?? '', since: Number.isFinite(cursor) ? cursor : 0 };
      })
      .filter((sub) => sub.id.length > 0 && this.sessions.get(sub.id) !== null);

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const writeTagged = (sessionId: string, event: unknown) => {
      res.write(`data: ${JSON.stringify({ sessionId, ...(event as object) })}\n\n`);
    };

    const unsubscribes: Array<() => void> = [];
    for (const sub of subs) {
      for (const event of this.sessions.getEvents(sub.id, sub.since)) {
        writeTagged(sub.id, event);
      }
      unsubscribes.push(this.sessions.subscribe(sub.id, (event) => writeTagged(sub.id, event)));
    }

    const heartbeat = setInterval(() => res.write(': ping\n\n'), 15000);
    res.on('close', () => {
      clearInterval(heartbeat);
      for (const unsubscribe of unsubscribes) unsubscribe();
      res.end();
    });
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
