import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Post,
} from '@nestjs/common';
import { LoopsService } from './loops.service';
import type { CreateLoopDto } from './loops.types';

/**
 * Loop primitive REST surface (rung 2 sub-phase C). UI-ready shapes so the rung-3
 * phone/fleet surfaces render directly. Auth is the global AuthGuard.
 */
@Controller('loops')
export class LoopsController {
  constructor(private readonly loops: LoopsService) {}

  @Get()
  list() {
    return { items: this.loops.list() };
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

  private requireLoop(id: string): void {
    if (!this.loops.findById(id)) throw new NotFoundException(`Loop ${id} not found`);
  }
}
