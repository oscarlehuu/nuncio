import type { CreateTaskDto, TaskDto } from '../../tasks/tasks.types';

/**
 * Narrow enqueue capability the orchestration tools need, injected by a DI token
 * so no value import of TasksService is required — this avoids the circular ESM
 * TDZ (TasksModule → SessionsModule → AgentToolsModule → OrchestrationToolsModule
 * → TasksService).
 */
export interface TaskEnqueuer {
  enqueue(input: CreateTaskDto): TaskDto;
}

export const TASK_ENQUEUER = Symbol('TASK_ENQUEUER');
