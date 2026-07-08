import { Module } from '@nestjs/common';
import { AttentionModule } from '../attention/attention.module';
import { HeartbeatModule } from '../attention/heartbeat/heartbeat.module';
import { LoopsModule } from '../loops/loops.module';
import { SessionsPersistenceModule } from '../sessions/sessions.persistence.module';
import { TasksModule } from '../tasks/tasks.module';
import { ObservabilityController, TimelineController } from './observability.controller';
import { ObservabilityService } from './observability.service';

@Module({
  imports: [
    SessionsPersistenceModule,
    TasksModule,
    LoopsModule,
    AttentionModule,
    HeartbeatModule,
  ],
  controllers: [ObservabilityController, TimelineController],
  providers: [ObservabilityService],
  exports: [ObservabilityService],
})
export class ObservabilityModule {}
