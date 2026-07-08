import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { LoopsService } from './loops.service';
import type { CreateLoopDto, UpdateLoopDto } from './loops.types';

/**
 * Loop primitive REST surface. UI-ready shapes so the rung-3 phone/fleet surfaces
 * render directly. Auth is the global AuthGuard.
 */
@Controller('loops')
export class LoopsController {
  constructor(private readonly loops: LoopsService) {}

  @Get()
  list() {
    return { items: this.loops.list() };
  }

  // Declared BEFORE ':id' so 'stats' is not captured as a loop id.
  @Get('stats')
  stats() {
    return this.loops.stats();
  }

  @Get(':id')
  get(@Param('id') id: string) {
    const loop = this.loops.findById(id);
    if (!loop) throw new NotFoundException(`Loop ${id} not found`);
    return loop;
  }

  @Post()
  create(@Body() body: CreateLoopDto) {
    if (!body?.goal?.trim()) throw new BadRequestException('goal is required');
    if (!body.schedule?.kind || !body.schedule?.spec) {
      throw new BadRequestException('schedule {kind, spec} is required');
    }
    return this.loops.create(body);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() body: UpdateLoopDto) {
    return this.loops.update(id, body ?? {});
  }

  @Post(':id/pause')
  pause(@Param('id') id: string) {
    this.requireLoop(id);
    return this.loops.pause(id);
  }

  @Post(':id/resume')
  resume(@Param('id') id: string) {
    this.requireLoop(id);
    return this.loops.resume(id);
  }

  @Post(':id/fire')
  fire(@Param('id') id: string) {
    // Manual run-now — bypasses the schedule, still consumes a run (budget + overlap).
    return this.loops.fireManual(id);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    this.requireLoop(id);
    this.loops.delete(id);
    return { ok: true };
  }

  @Get(':id/runs')
  runs(@Param('id') id: string) {
    this.requireLoop(id);
    return { items: this.loops.runs(id) };
  }

  @Get(':id/runs/:runId')
  runDetail(@Param('id') id: string, @Param('runId') runId: string) {
    this.requireLoop(id);
    return this.loops.runDetail(id, runId);
  }

  private requireLoop(id: string): void {
    if (!this.loops.findById(id)) throw new NotFoundException(`Loop ${id} not found`);
  }
}
