import { BadRequestException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { EventsRepository } from '../sessions/persistence/events.repository';
import { SessionsService } from '../sessions/sessions.service';
import { SettingsService } from '../settings/settings.service';
import { TasksRepository } from './tasks.repository';
import {
  TERMINAL_TASK_STATUSES,
  type CreateTaskDto,
  type TaskDto,
} from './tasks.types';

/** How many trailing events to scan when deriving "waiting on user input". */
const PENDING_SCAN_TAIL = 200;

@Injectable()
export class TasksService {
  constructor(
    private readonly tasks: TasksRepository,
    private readonly sessions: SessionsService,
    private readonly events: EventsRepository,
    @Optional() private readonly settings?: SettingsService,
  ) {
    // A RUNNING row at boot means the runner died mid-task; its session was
    // already reconciled by the sessions sweep. Queued work simply resumes.
    this.tasks.failInterrupted('daemon_restart');
    void this.pump();
  }

  list(): TaskDto[] {
    return this.tasks.list().map((task) => ({
      ...task,
      pendingInput:
        task.status === 'RUNNING' && task.sessionId
          ? this.hasPendingInput(task.sessionId)
          : false,
    }));
  }

  enqueue(input: CreateTaskDto): TaskDto {
    const prompt = input.prompt?.trim();
    if (!prompt) throw new BadRequestException('prompt is required');
    const task = this.tasks.create({ ...input, prompt });
    void this.pump();
    return task;
  }

  cancel(id: string): TaskDto {
    this.requireTask(id);
    const cancelled = this.tasks.cancel(id);
    if (!cancelled) {
      throw new BadRequestException('Only queued tasks can be cancelled');
    }
    return cancelled;
  }

  /** Explicit retry: clone a terminal task into a fresh queued run. */
  retry(id: string): TaskDto {
    const task = this.requireTask(id);
    if (!TERMINAL_TASK_STATUSES.includes(task.status)) {
      throw new BadRequestException('Only finished tasks can be retried');
    }
    return this.enqueue({
      prompt: task.prompt,
      ...(task.provider ? { provider: task.provider } : {}),
      ...(task.model ? { model: task.model } : {}),
      ...(task.modelOptions ? { modelOptions: task.modelOptions } : {}),
      ...(task.projectPath ? { projectPath: task.projectPath } : {}),
      ...(task.baseBranch ? { baseBranch: task.baseBranch } : {}),
      ...(task.useWorktree ? { useWorktree: true } : {}),
      ...(task.workspace ? { workspace: task.workspace } : {}),
    });
  }

  delete(id: string): void {
    this.requireTask(id);
    if (!this.tasks.delete(id)) {
      throw new BadRequestException('Only finished tasks can be deleted');
    }
  }

  private requireTask(id: string): TaskDto {
    const task = this.tasks.findById(id);
    if (!task) throw new NotFoundException('Task not found');
    return task;
  }

  private concurrency(): number {
    const raw = this.settings?.resolve('NUNCIO_TASK_CONCURRENCY');
    const parsed = Number(raw);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : 1;
  }

  /**
   * FIFO pump. The claim→spawn body is fully synchronous, so concurrent pump
   * calls cannot over-claim past the cap in a single-threaded runtime.
   */
  private pump(): void {
    while (this.tasks.countRunning() < this.concurrency()) {
      const task = this.tasks.claimNextQueued();
      if (!task) return;
      void this.execute(task).finally(() => this.pump());
    }
  }

  private async execute(task: TaskDto): Promise<void> {
    try {
      const session = await this.sessions.create({
        prompt: task.prompt,
        ...(task.provider ? { provider: task.provider } : {}),
        ...(task.model ? { model: task.model } : {}),
        ...(task.modelOptions ? { modelOptions: task.modelOptions } : {}),
        ...(task.projectPath ? { projectPath: task.projectPath } : {}),
        ...(task.baseBranch ? { baseBranch: task.baseBranch } : {}),
        ...(task.useWorktree ? { useWorktree: true } : {}),
        ...(task.workspace ? { workspace: task.workspace } : {}),
      });
      this.tasks.attachSession(task.id, session.id);
      await this.sessions.awaitRun(session.id);

      const final = this.sessions.get(session.id);
      const verify = this.lastVerifyResult(session.id);
      this.tasks.finish(task.id, final?.status === 'IDLE' ? 'DONE' : 'FAILED', {
        sessionStatus: final?.status ?? 'UNKNOWN',
        ...(verify ? { verify } : {}),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.tasks.finish(task.id, 'FAILED', { error: message });
    }
  }

  private lastVerifyResult(sessionId: string): Record<string, unknown> | null {
    const tail = this.events.listTail(sessionId, PENDING_SCAN_TAIL);
    for (let i = tail.length - 1; i >= 0; i -= 1) {
      const event = tail[i];
      if (event?.type === 'verify_result') {
        return event.payload as Record<string, unknown>;
      }
    }
    return null;
  }

  /** Open user-input or approval requests in the tail with no matching resolution. */
  private hasPendingInput(sessionId: string): boolean {
    const open = new Set<string>();
    for (const event of this.events.listTail(sessionId, PENDING_SCAN_TAIL)) {
      const payload = event.payload as { requestId?: string } | null;
      const requestId = payload?.requestId;
      if (!requestId) continue;
      if (event.type === 'user_input_requested' || event.type === 'provider_request') {
        open.add(requestId);
      }
      if (event.type === 'user_input_resolved' || event.type === 'provider_request_resolved') {
        open.delete(requestId);
      }
    }
    return open.size > 0;
  }
}
