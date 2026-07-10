import {
  BadRequestException, Body, ConflictException, Controller, Delete, Get, NotFoundException,
  Param, Patch, Post, Query,
} from '@nestjs/common';
import { CrewService } from '../crew.service';
import { publicCrewRun } from '../crew-run-query.service';
import {
  CrewNotFoundError, CrewProfileNeedsSetupError, CrewProfileRevisionConflictError,
  CrewRevisionConflictError, CrewValidationError,
} from '../domain/crew-errors';
import { CrewTransitionError } from '../domain/crew-run.reducer';
import {
  cursorNumber, expectedRevision, normalizeOverride, normalizeProfileDefinition, requiredString,
} from './crew-api.validation';

@Controller()
export class CrewController {
  constructor(private readonly crew: CrewService) {}

  @Get('crew/presets') getPresets() { return { presets: this.crew.presets() }; }
  @Get('crew/profiles') listProfiles() { return { profiles: this.crew.listProfiles() }; }
  @Get('crew/profiles/:id') getProfile(@Param('id') id: string) {
    return this.map(() => ({ profile: this.crew.getProfile(id) }));
  }
  @Post('crew/profiles') createProfile(@Body() body: Record<string, unknown>) {
    const name = requiredString(body?.name, 'name', 256);
    if (body?.presetId !== 'quality') throw new BadRequestException('presetId must be quality');
    const definition = normalizeProfileDefinition(body.definition);
    return this.mapAsync(async () => ({
      profile: await this.crew.createProfile({ name, presetId: 'quality', definition }),
    }));
  }
  @Patch('crew/profiles/:id') updateProfile(
    @Param('id') id: string, @Body() body: Record<string, unknown>,
  ) {
    const revision = expectedRevision(body?.expectedRevision);
    const name = body?.name === undefined ? undefined : requiredString(body.name, 'name', 256);
    const definition = body?.definition === undefined ? undefined : normalizeProfileDefinition(body.definition);
    if (name === undefined && definition === undefined) throw new BadRequestException('profile patch is empty');
    return this.mapAsync(async () => ({
      profile: await this.crew.updateProfile(id, revision, { name, definition }),
    }));
  }
  @Delete('crew/profiles/:id') deleteProfile(@Param('id') id: string) {
    return this.map(() => { this.crew.deleteProfile(id); return { ok: true }; });
  }
  @Post('crew/profiles/:id/resolve') resolveProfile(
    @Param('id') id: string, @Body() body: Record<string, unknown> = {},
  ) {
    return this.mapAsync(async () => ({ resolution: await this.crew.resolveProfile(id, {
      projectPath: body.projectPath == null ? null : requiredString(body.projectPath, 'projectPath', 4096),
      projectOverride: normalizeOverride(body.projectOverride), runOverride: normalizeOverride(body.override),
    }) }));
  }

  @Post('crew/tasks') createTask(@Body() body: Record<string, unknown>) {
    const input = {
      objective: requiredString(body?.objective, 'objective'),
      projectPath: requiredString(body?.projectPath, 'projectPath', 4096),
      profileId: requiredString(body?.profileId, 'profileId', 512),
      baseBranch: body?.baseBranch == null ? null : requiredString(body.baseBranch, 'baseBranch', 512),
      override: normalizeOverride(body?.override),
    };
    return this.mapAsync(async () => publicRunEnvelope(await this.crew.createTask(input)));
  }
  @Get('crew/tasks/:id') getTask(@Param('id') id: string) {
    return this.map(() => publicTaskEnvelope(this.crew.getTask(id)));
  }
  @Post('crew/tasks/:id/runs') createSuccessor(
    @Param('id') id: string, @Body() body: Record<string, unknown>,
  ) {
    return this.mapAsync(async () => publicRunEnvelope(await this.crew.createSuccessor(id, {
      priorRunId: requiredString(body?.priorRunId, 'priorRunId', 512),
      expectedRevision: expectedRevision(body?.expectedRevision),
      expectedBaseHead: requiredString(body?.expectedBaseHead, 'expectedBaseHead', 128),
      changeRequest: requiredString(body?.changeRequest, 'changeRequest'),
      profileId: body?.profileId == null ? undefined : requiredString(body.profileId, 'profileId', 512),
      override: normalizeOverride(body?.override),
    })));
  }

  @Get('crew-runs') listRuns(
    @Query('status') status?: string, @Query('projectPath') projectPath?: string,
    @Query('limit') limit?: string, @Query('offset') offset?: string,
  ) {
    const safeLimit = cursorNumber(limit, 20, 100);
    if (safeLimit < 1) throw new BadRequestException('limit must be from 1 to 100');
    return { runs: this.crew.listRunSummaries({
      status, projectPath, limit: safeLimit,
      offset: cursorNumber(offset, 0, Number.MAX_SAFE_INTEGER),
    }) };
  }
  @Get('crew-runs/:id') getRun(@Param('id') id: string) {
    return this.map(() => publicRunEnvelope(this.crew.getRunDetail(id)));
  }
  @Get('crew-runs/:id/events') getEvents(
    @Param('id') id: string, @Query('since') since?: string, @Query('limit') limit?: string,
  ) {
    return this.map(() => this.crew.listEvents(
      id, cursorNumber(since, 0, Number.MAX_SAFE_INTEGER), cursorNumber(limit, 200, 1000),
    ));
  }
  @Get('crew-runs/:id/artifacts/:artifactId') getArtifact(
    @Param('id') id: string, @Param('artifactId') artifactId: string,
    @Query('offset') offset?: string, @Query('limit') limit?: string,
  ) {
    const safeLimit = cursorNumber(limit, 16_384, 65_536);
    if (safeLimit < 1) throw new BadRequestException('limit must be from 1 to 65536');
    return this.map(() => ({
      range: this.crew.readArtifactRange(
        id, artifactId, cursorNumber(offset, 0, Number.MAX_SAFE_INTEGER), safeLimit,
      ),
    }));
  }

  @Post('crew-runs/:id/pause') pause(@Param('id') id: string, @Body() body: Record<string, unknown>) {
    return this.command(() => this.crew.pause(id, expectedRevision(body?.expectedRevision)));
  }
  @Post('crew-runs/:id/resume') resume(@Param('id') id: string, @Body() body: Record<string, unknown>) {
    return this.command(() => this.crew.resume(id, expectedRevision(body?.expectedRevision)));
  }
  @Post('crew-runs/:id/cancel') cancel(@Param('id') id: string, @Body() body: Record<string, unknown>) {
    return this.command(() => this.crew.cancel(id, expectedRevision(body?.expectedRevision)));
  }
  @Post('crew-runs/:id/clarification') clarification(
    @Param('id') id: string, @Body() body: Record<string, unknown>,
  ) {
    const revision = expectedRevision(body?.expectedRevision);
    const message = requiredString(body?.message, 'message');
    return this.command(() => this.crew.clarification(id, revision, message));
  }
  @Post('crew-runs/:id/extra-round') extraRound(
    @Param('id') id: string, @Body() body: Record<string, unknown>,
  ) {
    const revision = expectedRevision(body?.expectedRevision);
    const gate = body?.gate;
    if (gate !== 'verify' && gate !== 'review') throw new BadRequestException('gate must be verify or review');
    return this.command(() => this.crew.extraRound(id, revision, gate));
  }

  private command(fn: () => ReturnType<CrewService['pause']>) {
    return this.mapAsync(async () => ({ run: publicCrewRun(await fn()) }));
  }
  private async mapAsync<T>(fn: () => Promise<T> | T): Promise<T> {
    try { return await fn(); } catch (error) { throw this.toHttpError(error); }
  }
  private map<T>(fn: () => T): T {
    try { return fn(); } catch (error) { throw this.toHttpError(error); }
  }
  private toHttpError(error: unknown): unknown {
      if (error instanceof CrewRevisionConflictError) throw new ConflictException({
        code: 'CREW_REVISION_CONFLICT', message: error.message, expectedRevision: error.expectedRevision,
        currentRevision: error.currentRevision, current: publicCrewRun(error.current),
      });
      if (error instanceof CrewProfileRevisionConflictError) throw new ConflictException({
        code: 'CREW_PROFILE_REVISION_CONFLICT', message: error.message,
        expectedRevision: error.expectedRevision, currentRevision: error.current.revision, current: error.current,
      });
      if (error instanceof CrewProfileNeedsSetupError) throw new ConflictException({
        code: 'CREW_PROFILE_NEEDS_SETUP', message: error.message, issues: error.issues,
      });
      if (error instanceof CrewTransitionError) throw new ConflictException({ code: 'CREW_INVALID_TRANSITION', message: error.message });
      if (error instanceof CrewNotFoundError) throw new NotFoundException(error.message);
      if (error instanceof CrewValidationError) throw new BadRequestException(error.message);
      return error;
  }
}

function publicRunEnvelope<T extends { run: unknown }>(value: T): T {
  return { ...value, run: publicCrewRun(value.run) };
}

function publicTaskEnvelope<T extends { runs: unknown[] }>(value: T): T {
  return { ...value, runs: value.runs.map(publicCrewRun) };
}
