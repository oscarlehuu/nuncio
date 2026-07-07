import { Module } from '@nestjs/common';
import { DatabaseModule } from '../db/database.module';
import { ProjectsModule } from '../projects/projects.module';
import { SchedulerModule } from '../scheduler/scheduler.module';
import { TasksModule } from '../tasks/tasks.module';
import { LoopsController } from './loops.controller';
import { LoopsRepository } from './loops.repository';
import { LoopsService } from './loops.service';

/**
 * Rung 2 sub-phase C — the loop primitive. Standing tasks that fire loop-runs
 * through the scheduler inside budgets + a breaker, landing output via
 * worktree + PR. All budget/breaker/stop state folds from durable loop_runs rows.
 */
@Module({
  imports: [DatabaseModule, SchedulerModule, TasksModule, ProjectsModule],
  controllers: [LoopsController],
  providers: [LoopsRepository, LoopsService],
  exports: [LoopsRepository, LoopsService],
})
export class LoopsModule {}
