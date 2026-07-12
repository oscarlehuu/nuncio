import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Optional,
  Param,
  Patch,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { validateHandoffBrief } from '../../orchestration/handoff-brief.validate';
import type {
  CreateSessionDto,
  HandoffSessionDto,
  RespondInteractionDto,
  RespondProviderRequestDto,
  SetSessionModelDto,
  SteerSessionDto,
} from '../domain/sessions.types';
import { SessionsService } from '../sessions.service';
import { sniffImageMime } from '../media.store';
import { EvidenceCaptureService } from '../../evidence/evidence-capture.service';
import type { CaptureEvidenceDto } from '../../evidence/evidence.types';

function parsePositiveInt(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

@Controller('sessions')
export class SessionsController {
  constructor(
    private readonly sessions: SessionsService,
    @Optional() private readonly evidence?: EvidenceCaptureService,
  ) {}

  @Get()
  list(@Query('includeArchived') includeArchived?: string) {
    return this.sessions.list(includeArchived === '1' || includeArchived === 'true');
  }

  @Post()
  create(@Body() body: CreateSessionDto) {
    if (!body?.prompt?.trim()) {
      return { error: 'prompt is required' };
    }
    const contextBrief = this.parseBrief(body.contextBrief);
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
      ...(contextBrief ? { contextBrief } : {}),
    });
  }

  /** Validate a caller-supplied handoff brief at the boundary (same as the tasks API). */
  private parseBrief(raw: unknown) {
    if (raw === undefined || raw === null) return undefined;
    try {
      return validateHandoffBrief(raw);
    } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : 'invalid contextBrief');
    }
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

  @Get(':id/lineage')
  lineage(@Param('id') id: string) {
    return this.sessions.lineage(id);
  }

  @Post(':id/refresh-transcript')
  refreshTranscript(@Param('id') id: string) {
    const session = this.sessions.get(id);
    if (!session) throw new NotFoundException('Session not found');
    return this.sessions.refreshTranscript(id);
  }

  @Get(':id/media/:mediaId')
  media(
    @Param('id') id: string,
    @Param('mediaId') mediaId: string,
    @Res() res: Response,
  ) {
    const bytes = this.sessions.readMedia(id, mediaId);
    if (!bytes) throw new NotFoundException('Image not found');
    res.setHeader('Content-Type', sniffImageMime(bytes));
    // Content is immutable (id addresses fixed bytes); cache hard but keep it private.
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
    res.send(bytes);
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

  @Post(':id/evidence')
  async captureEvidence(@Param('id') id: string, @Body() body: CaptureEvidenceDto) {
    const session = this.sessions.get(id);
    if (!session) throw new NotFoundException('Session not found');
    if (!this.evidence) throw new BadRequestException('Evidence capture is unavailable');
    const captured = await this.evidence.capture(session, body);
    this.sessions.appendOrchestrationEvent(id, 'evidence_captured', captured);
    return captured;
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
  async delete(@Param('id') id: string) {
    await this.sessions.delete(id);
    this.evidence?.forget(id);
    return { ok: true };
  }

  @Get(':id/events')
  events(
    @Param('id') id: string,
    @Query('since') since?: string,
    @Query('limit') limit?: string,
    @Query('tail') tail?: string,
    @Query('before') before?: string,
  ) {
    const session = this.sessions.get(id);
    if (!session) throw new NotFoundException('Session not found');
    const cursor = since ? Number(since) : 0;
    return this.sessions.getEvents(id, Number.isFinite(cursor) ? cursor : 0, {
      ...(parsePositiveInt(limit) !== undefined ? { limit: parsePositiveInt(limit) } : {}),
      ...(parsePositiveInt(tail) !== undefined ? { tail: parsePositiveInt(tail) } : {}),
      ...(parsePositiveInt(before) !== undefined ? { before: parsePositiveInt(before) } : {}),
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
