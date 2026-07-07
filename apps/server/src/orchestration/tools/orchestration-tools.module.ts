import { Module } from '@nestjs/common';
import { AgentsModule } from '../../agents/agents.module';
import { SessionsPersistenceModule } from '../../sessions/sessions.persistence.module';
import { SettingsModule } from '../../settings/settings.module';
import { TasksRepository } from '../../tasks/tasks.repository';
import { OrchestrationToolsService } from './orchestration-tools.service';

/**
 * Owns the orchestration-tools factory wiring. It provides its own
 * TasksRepository (a stateless view over the shared DB) so read tools work in
 * any module graph; the enqueue capability arrives via the OPTIONAL global
 * TASK_ENQUEUER token (provided by the @Global TasksModule when the full app is
 * built). AgentsModule supplies AgentRegistry for engine-routing availability
 * checks; it does not import back, so no module-load cycle is created.
 */
@Module({
  imports: [SessionsPersistenceModule, SettingsModule, AgentsModule],
  providers: [OrchestrationToolsService, TasksRepository],
  exports: [OrchestrationToolsService],
})
export class OrchestrationToolsModule {}
