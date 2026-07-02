import { Body, Controller, Delete, Get, Param, Post } from '@nestjs/common';
import { TasksService } from './tasks.service';
import type { CreateTaskDto } from './tasks.types';

@Controller('tasks')
export class TasksController {
  constructor(private readonly tasks: TasksService) {}

  @Get()
  list() {
    return this.tasks.list();
  }

  @Post()
  create(@Body() body: CreateTaskDto) {
    if (!body?.prompt?.trim()) {
      return { error: 'prompt is required' };
    }
    return this.tasks.enqueue({
      prompt: body.prompt.trim(),
      ...(body.provider ? { provider: body.provider } : {}),
      ...(body.model ? { model: body.model } : {}),
      ...(body.modelOptions ? { modelOptions: body.modelOptions } : {}),
      ...(body.projectPath ? { projectPath: body.projectPath } : {}),
      ...(body.baseBranch ? { baseBranch: body.baseBranch } : {}),
      ...(body.useWorktree === true ? { useWorktree: true } : {}),
      ...(body.workspace ? { workspace: body.workspace } : {}),
    });
  }

  @Post(':id/cancel')
  cancel(@Param('id') id: string) {
    return this.tasks.cancel(id);
  }

  @Post(':id/retry')
  retry(@Param('id') id: string) {
    return this.tasks.retry(id);
  }

  @Delete(':id')
  delete(@Param('id') id: string) {
    this.tasks.delete(id);
    return { ok: true };
  }
}
