import { Global, Module } from '@nestjs/common';
import { AgentsModule } from '../agents/agents.module';
import { TASK_ENQUEUER } from '../orchestration/tools/task-enqueuer.token';
import { PromptsModule } from '../prompts/prompts.module';
import { SessionsModule } from '../sessions/sessions.module';
import { SessionsPersistenceModule } from '../sessions/sessions.persistence.module';
import { SettingsModule } from '../settings/settings.module';
import { TasksController } from './tasks.controller';
import { TasksRepository } from './tasks.repository';
import { TasksService } from './tasks.service';

// Global so the TASK_ENQUEUER token is injectable by OrchestrationToolsModule
// without a value import of TasksModule — that import would close a module-load
// cycle (Sessions → AgentTools → OrchestrationTools → Tasks → Sessions).
// AgentsModule gives the controller AgentRegistry for engine-routing.
@Global()
@Module({
  imports: [AgentsModule, PromptsModule, SessionsModule, SessionsPersistenceModule, SettingsModule],
  controllers: [TasksController],
  providers: [TasksRepository, TasksService, { provide: TASK_ENQUEUER, useExisting: TasksService }],
  exports: [TasksService, TasksRepository, TASK_ENQUEUER],
})
export class TasksModule {}
