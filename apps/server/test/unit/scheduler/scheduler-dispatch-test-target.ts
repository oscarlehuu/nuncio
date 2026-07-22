import 'reflect-metadata';
import { DatabaseService } from '../../../src/db/database.service';
import { TasksRepository } from '../../../src/tasks/tasks.repository';
import type { CreateTaskDto, TaskDto } from '../../../src/tasks/tasks.types';

export class PersistingTaskTarget {
  constructor(
    private readonly database: DatabaseService,
    private readonly tasks: TasksRepository,
  ) {}

  enqueue(input: CreateTaskDto): TaskDto {
    return this.tasks.create(input);
  }

  enqueueCorrelated<T>(
    input: CreateTaskDto,
    correlate: (task: TaskDto) => T,
  ): { task: TaskDto; correlated: T } {
    return this.database.transaction(() => {
      const task = this.tasks.createInCurrentTransaction(input);
      return { task, correlated: correlate(task) };
    });
  }

  deferPumpUntilCommit<T>(work: () => T): { result: T; afterCommit: () => void } {
    return { result: work(), afterCommit: () => {} };
  }

  findById(id: string): TaskDto | null {
    return this.tasks.findById(id);
  }

  onTaskFinished(): () => void {
    return () => {};
  }
}

export function at(hour: number, minute: number): number {
  return new Date(2026, 6, 7, hour, minute, 0, 0).getTime();
}

export function intentStatus(database: DatabaseService): string | null {
  const row = database.db.prepare<{ status: string }, []>(
    'SELECT status FROM schedule_dispatch_intents ORDER BY created_at LIMIT 1',
  ).get();
  return row?.status ?? null;
}
