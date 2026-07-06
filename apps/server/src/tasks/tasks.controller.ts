import { BadRequestException, Body, Controller, Delete, Get, Param, Post, Query } from '@nestjs/common';
import { validateHandoffBrief } from '../orchestration/handoff-brief.validate';
import { TasksService } from './tasks.service';
import type { CreateTaskDto, StartMultitaskDto } from './tasks.types';

@Controller('tasks')
export class TasksController {
  constructor(private readonly tasks: TasksService) {}

  @Get()
  list(@Query('parentSessionId') parentSessionId?: string) {
    return this.tasks.list(parentSessionId);
  }

  @Post()
  create(@Body() body: CreateTaskDto) {
    if (!body?.prompt?.trim()) {
      return { error: 'prompt is required' };
    }
    const contextBrief = this.parseBrief(body.contextBrief);
    return this.tasks.enqueue({
      prompt: body.prompt.trim(),
      ...(body.provider ? { provider: body.provider } : {}),
      ...(body.model ? { model: body.model } : {}),
      ...(body.modelOptions ? { modelOptions: body.modelOptions } : {}),
      ...(body.projectPath ? { projectPath: body.projectPath } : {}),
      ...(body.baseBranch ? { baseBranch: body.baseBranch } : {}),
      ...(body.useWorktree === true ? { useWorktree: true } : {}),
      ...(body.workspace ? { workspace: body.workspace } : {}),
      ...(contextBrief ? { contextBrief } : {}),
    });
  }

  private parseBrief(raw: unknown) {
    if (raw === undefined || raw === null) return undefined;
    try {
      return validateHandoffBrief(raw);
    } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : 'invalid contextBrief');
    }
  }

  @Post('multitask')
  multitask(@Body() body: StartMultitaskDto) {
    const prompts = body?.prompts
      ?.map((prompt) => prompt.trim())
      .filter(Boolean);
    if (!prompts?.length) {
      throw new BadRequestException('at least one prompt is required');
    }
    const contextBrief = this.parseBrief(body.contextBrief);
    return this.tasks.startMultitask({
      parentSessionId: body.parentSessionId,
      prompts,
      ...(body.provider ? { provider: body.provider } : {}),
      ...(body.model ? { model: body.model } : {}),
      ...(body.modelOptions ? { modelOptions: body.modelOptions } : {}),
      ...(body.projectPath ? { projectPath: body.projectPath } : {}),
      ...(body.baseBranch ? { baseBranch: body.baseBranch } : {}),
      ...(body.useWorktree === true || body.useWorktree === false
        ? { useWorktree: body.useWorktree }
        : {}),
      ...(body.workspace ? { workspace: body.workspace } : {}),
      ...(body.cleanupPolicy ? { cleanupPolicy: body.cleanupPolicy } : {}),
      ...(contextBrief ? { contextBrief } : {}),
    });
  }

  @Post('multitask-from-queue')
  multitaskFromQueue(@Body() body: { parentSessionId?: string }) {
    if (!body?.parentSessionId?.trim()) {
      throw new BadRequestException('parentSessionId is required');
    }
    return this.tasks.startMultitaskFromQueue(body.parentSessionId.trim());
  }

  @Post(':id/cancel')
  cancel(@Param('id') id: string) {
    return this.tasks.cancel(id);
  }

  @Post(':id/retry')
  retry(@Param('id') id: string) {
    return this.tasks.retry(id);
  }

  @Post(':id/reviewed')
  markReviewed(@Param('id') id: string) {
    return this.tasks.markReviewed(id);
  }

  @Delete(':id')
  delete(@Param('id') id: string) {
    this.tasks.delete(id);
    return { ok: true };
  }
}
