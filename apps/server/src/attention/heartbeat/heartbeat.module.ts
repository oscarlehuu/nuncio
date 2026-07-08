import { Module } from '@nestjs/common';
import { AttentionModule } from '../attention.module';
import { DatabaseModule } from '../../db/database.module';
import { ForgesModule } from '../../forges/forges.module';
import { LoopsModule } from '../../loops/loops.module';
import { PushModule } from '../../push/push.module';
import { SchedulerModule } from '../../scheduler/scheduler.module';
import { SessionsPersistenceModule } from '../../sessions/sessions.persistence.module';
import { SettingsModule } from '../../settings/settings.module';
import { TasksModule } from '../../tasks/tasks.module';
import { DigestRepository } from './digest.repository';
import { HeartbeatController } from './heartbeat.controller';
import { HeartbeatService } from './heartbeat.service';
import { InfraChecks } from './infra-checks';

/**
 * Heartbeat (rung 3, sub-phase B). 3 rhythm layers on the rung-2 scheduler: infra
 * self-check / fleet reconciliation / human digest. It rides the scheduler as
 * `{kind:'system'}` schedules and folds infra-check results into the attention
 * queue. Nothing imports this module, so pulling the feature modules in here
 * introduces no cycle.
 */
@Module({
  imports: [
    DatabaseModule,
    SchedulerModule,
    SettingsModule,
    AttentionModule,
    LoopsModule,
    PushModule,
    ForgesModule,
    SessionsPersistenceModule,
    TasksModule,
  ],
  controllers: [HeartbeatController],
  providers: [HeartbeatService, InfraChecks, DigestRepository],
  exports: [HeartbeatService, DigestRepository],
})
export class HeartbeatModule {}
