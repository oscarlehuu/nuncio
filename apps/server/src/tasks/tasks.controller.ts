import { BadRequestException, Body, Controller, Delete, Get, Optional, Param, Post, Query } from '@nestjs/common';
import { AgentRegistry } from '../agents/agents.registry';
import { validateHandoffBrief } from '../orchestration/handoff-brief.validate';
import { resolveTaskEngine } from '../orchestration/engine-routing';
import { SettingsService } from '../settings/settings.service';
import { TasksService } from './tasks.service';
import { NOTIFY_POLICIES, type CreateTaskDto, type NotifyPolicy, type StartMultitaskDto } from './tasks.types';

const ROUTING_TAGS = new Set(['mechanical', 'review', 'design', 'research']);

@Controller('tasks')
export class TasksController {
  constructor(
    private readonly tasks: TasksService,
    @Optional() private readonly settings?: SettingsService,
    @Optional() private readonly agents?: AgentRegistry,
  ) {}

  @Get()
  list(@Query('parentSessionId') parentSessionId?: string) {
    return this.tasks.list(parentSessionId);
  }

  @Post()
  async create(@Body() body: CreateTaskDto & { tag?: string }) {
    if (!body?.prompt?.trim()) {
      return { error: 'prompt is required' };
    }
    const contextBrief = this.parseBrief(body.contextBrief);
    const notifyPolicy = this.parseNotifyPolicy(body.notifyPolicy);
    const tag = this.parseTag(body.tag);

    // Shared engine resolution (same path the enqueue tool uses): explicit
    // provider > tag routing > default provider. Only routes when a tag is set.
    const explicitProvider = body.provider?.trim() || undefined;
    const defaultProvider = explicitProvider ?? (this.agents ? await this.agents.defaultId() : '');
    const resolved = await resolveTaskEngine(
      {
        explicitProvider,
        tag,
        authorProvider: defaultProvider,
        defaultProvider,
        defaultModel: body.model ?? null,
      },
      {
        routingJson: this.settings?.resolve('NUNCIO_ENGINE_ROUTING'),
        availableProviderIds: async () =>
          this.agents ? (await this.agents.available()).map((p) => p.id) : [],
      },
    );

    return this.tasks.enqueue({
      prompt: body.prompt.trim(),
      ...(resolved.provider ? { provider: resolved.provider } : {}),
      ...(resolved.model ? { model: resolved.model } : {}),
      ...(body.modelOptions ? { modelOptions: body.modelOptions } : {}),
      ...(body.projectPath ? { projectPath: body.projectPath } : {}),
      ...(body.baseBranch ? { baseBranch: body.baseBranch } : {}),
      ...(body.useWorktree === true ? { useWorktree: true } : {}),
      ...(body.workspace ? { workspace: body.workspace } : {}),
      ...(contextBrief ? { contextBrief } : {}),
      ...(notifyPolicy ? { notifyPolicy } : {}),
      ...(tag ? { tag } : {}),
    });
  }

  private parseTag(raw: unknown): string | undefined {
    if (raw === undefined || raw === null) return undefined;
    if (typeof raw !== 'string' || !ROUTING_TAGS.has(raw)) {
      throw new BadRequestException(`tag must be one of: ${[...ROUTING_TAGS].join(', ')}`);
    }
    return raw;
  }

  private parseBrief(raw: unknown) {
    if (raw === undefined || raw === null) return undefined;
    try {
      return validateHandoffBrief(raw);
    } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : 'invalid contextBrief');
    }
  }

  private parseNotifyPolicy(raw: unknown): NotifyPolicy | undefined {
    if (raw === undefined || raw === null) return undefined;
    if (!NOTIFY_POLICIES.includes(raw as NotifyPolicy)) {
      throw new BadRequestException(`notifyPolicy must be one of: ${NOTIFY_POLICIES.join(', ')}`);
    }
    return raw as NotifyPolicy;
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
    const notifyPolicy = this.parseNotifyPolicy(body.notifyPolicy);
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
      ...(notifyPolicy ? { notifyPolicy } : {}),
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
