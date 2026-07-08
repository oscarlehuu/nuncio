import { Module } from '@nestjs/common';
import { AgentsModule } from '../../agents/agents.module';
import { ContextModule } from '../../context/context.module';
import { PromptsModule } from '../../prompts/prompts.module';
import { SessionsPersistenceModule } from '../../sessions/sessions.persistence.module';
import { SettingsModule } from '../../settings/settings.module';
import { TasksRepository } from '../../tasks/tasks.repository';
import { OrchestrationToolsService } from './orchestration-tools.service';

/**
 * Owns the orchestration-tools factory wiring. It provides its own
 * TasksRepository (a stateless view over the shared DB) so read tools work in
 * any module graph; the enqueue capability arrives via the OPTIONAL global
 * TASK_ENQUEUER token (provided by the @Global TasksModule when the full app is
 * built). AgentsModule supplies AgentRegistry for engine-routing availability;
 * ContextModule supplies ContextFactsService for the fact tools. Neither imports
 * back, so no module-load cycle is created.
 */
@Module({
  imports: [SessionsPersistenceModule, SettingsModule, AgentsModule, ContextModule, PromptsModule],
  providers: [OrchestrationToolsService, TasksRepository],
  exports: [OrchestrationToolsService],
})
export class OrchestrationToolsModule {}
