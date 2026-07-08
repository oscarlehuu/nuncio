import { Module } from '@nestjs/common';
import { AttentionModule } from '../attention/attention.module';
import { LoopsModule } from '../loops/loops.module';
import { ProjectsModule } from '../projects/projects.module';
import { SchedulerModule } from '../scheduler/scheduler.module';
import { SessionsPersistenceModule } from '../sessions/sessions.persistence.module';
import { SettingsModule } from '../settings/settings.module';
import { TasksModule } from '../tasks/tasks.module';
import { DispatcherController } from './dispatcher.controller';
import { DispatcherService } from './dispatcher.service';

@Module({
  imports: [
    AttentionModule,
    LoopsModule,
    ProjectsModule,
    SchedulerModule,
    SessionsPersistenceModule,
    SettingsModule,
    TasksModule,
  ],
  controllers: [DispatcherController],
  providers: [DispatcherService],
  exports: [DispatcherService],
})
export class DispatcherModule {}
