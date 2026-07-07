import { Module } from '@nestjs/common';
import { DatabaseModule } from '../db/database.module';
import { SchedulerModule } from '../scheduler/scheduler.module';
import { LoopsRepository } from './loops.repository';
import { LoopsService } from './loops.service';

/**
 * Rung 2 sub-phase C — the loop primitive. Standing tasks that fire loop-runs
 * through the scheduler inside budgets + a breaker, landing output via
 * worktree + PR. Skeleton wiring; driven red-first by the sub-phase C suite.
 */
@Module({
  imports: [DatabaseModule, SchedulerModule],
  providers: [LoopsRepository, LoopsService],
  exports: [LoopsRepository, LoopsService],
})
export class LoopsModule {}
