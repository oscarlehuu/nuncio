import { Module } from '@nestjs/common';
import { DatabaseModule } from '../db/database.module';
import { TasksModule } from '../tasks/tasks.module';
import { SchedulerService } from './scheduler.service';
import { SchedulesRepository } from './schedules.repository';

/**
 * Rung 2 sub-phase B — the scheduler. Durable, restart-safe cron/event/heartbeat
 * triggers that fire targets through TasksService. Skeleton wiring; driven
 * red-first by the sub-phase B suite.
 */
@Module({
  imports: [DatabaseModule, TasksModule],
  providers: [SchedulesRepository, SchedulerService],
  exports: [SchedulesRepository, SchedulerService],
})
export class SchedulerModule {}
