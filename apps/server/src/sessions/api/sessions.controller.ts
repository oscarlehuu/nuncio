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
  HandoffToProviderDto,
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

const SSE_MAX_PENDING_BYTES = 1_000_000;
type SseStopReason = 'downstream' | 'overflow' | 'write-error';

function createBoundedSseWriter(res: Response, onStop: () => void) {
  const pending: Array<{ frame: string; bytes: number }> = [];
  let pendingBytes = 0;
  let blocked = false;
  let stopped = false;

  const safeEnd = () => {
    if (res.writableEnded || res.destroyed) return;
    try {
      res.end();
    } catch {
      // The response already failed; cleanup still remains exact.
    }
  };
  const stop = (reason: SseStopReason) => {
    if (stopped) return;
    stopped = true;
    blocked = false;
    pending.length = 0;
    pendingBytes = 0;
    res.off('drain', onDrain);
    res.off('close', onClose);
    res.off('error', onError);
    onStop();
    if (reason !== 'downstream') safeEnd();
  };
  const writeNow = (frame: string): boolean => {
    if (stopped) return false;
    if (res.writableEnded || res.destroyed) {
      stop('downstream');
      return false;
    }
    try {
      if (!res.write(frame)) blocked = true;
      return true;
    } catch {
      stop('write-error');
      return false;
    }
  };
  const send = (frame: string): boolean => {
    if (stopped) return false;
    if (!blocked && pending.length === 0) return writeNow(frame);

    const bytes = Buffer.byteLength(frame);
    if (bytes > SSE_MAX_PENDING_BYTES - pendingBytes) {
      stop('overflow');
      return false;
    }
    pending.push({ frame, bytes });
    pendingBytes += bytes;
    return true;
  };
  function onDrain() {
    if (stopped) return;
    blocked = false;
    while (!blocked && pending.length > 0) {
      const next = pending.shift()!;
      pendingBytes -= next.bytes;
      if (!writeNow(next.frame)) return;
    }
  }
  function onClose() {
    stop('downstream');
  }
  function onError() {
    stop('downstream');
  }

  res.on('drain', onDrain);
  res.on('close', onClose);
  res.on('error', onError);
  return {
    send,
    fail: () => stop('write-error'),
    stopped: () => stopped,
  };
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
      mode: body.mode,
      attachments: body.attachments,
      workspace: body.workspace,
      projectPath: body.projectPath,
      baseBranch: body.baseBranch,
      useWorktree: body.useWorktree,
      ...(body.mcpServerIds !== undefined ? { mcpServerIds: body.mcpServerIds } : {}),
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

  @Post(':id/handoff-to')
  handoffTo(@Param('id') id: string, @Body() body: HandoffToProviderDto) {
    if (!body?.provider?.trim()) {
      throw new BadRequestException('provider is required');
    }
    return this.sessions.handoffToProvider(id, {
      provider: body.provider.trim(),
      ...(body.model?.trim() ? { model: body.model.trim() } : {}),
      ...(body.prompt?.trim() ? { prompt: body.prompt.trim() } : {}),
    });
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
    if (body?.phase !== 'before' && body?.phase !== 'after') {
      throw new BadRequestException('phase must be before or after');
    }
    if (body.target !== undefined && body.target !== 'browser' && body.target !== 'simulator') {
      throw new BadRequestException('target must be browser or simulator');
    }
    if (body.target !== 'simulator' && !body.url) {
      throw new BadRequestException('url is required for browser evidence');
    }
    const session = this.sessions.requirePublicMutableSession(id);
    if (!this.evidence) throw new BadRequestException('Evidence capture is unavailable');
    const captured = await this.evidence.capture(session, body);
    if ('unavailable' in captured) return captured;
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
    const archived = this.sessions.archive(id);
    this.evidence?.forget(id);
    return archived;
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

    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let unsubscribe: (() => void) | undefined;
    const cleanup = () => {
      if (heartbeat !== undefined) {
        clearInterval(heartbeat);
        heartbeat = undefined;
      }
      const current = unsubscribe;
      unsubscribe = undefined;
      if (current) {
        try {
          current();
        } catch {
          // The response is already terminal; a subscriber cleanup failure cannot recover it.
        }
      }
    };
    const writer = createBoundedSseWriter(res, cleanup);

    for (const event of this.sessions.getEvents(id, safeSince)) {
      if (!writer.send(`data: ${JSON.stringify(event)}\n\n`)) return;
    }

    if (!writer.stopped()) {
      let subscribed: (() => void) | undefined;
      try {
        subscribed = this.sessions.subscribe(id, (event) => {
          writer.send(`data: ${JSON.stringify(event)}\n\n`);
        });
      } catch {
        writer.fail();
        return;
      }
      if (writer.stopped()) {
        try {
          subscribed?.();
        } catch {
          // Cleanup remains best-effort after a terminal response.
        }
        return;
      }
      unsubscribe = subscribed;
      heartbeat = setInterval(() => {
        writer.send(': ping\n\n');
      }, 15000);
    }
  }
}
