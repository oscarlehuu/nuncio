import { Module } from '@nestjs/common';
import { SessionsPersistenceModule } from '../sessions/sessions.persistence.module';
import { AgentRegistry } from './agents.registry';
import { MockAgentProvider } from './providers/mock-agent.provider';
import { PiAgentProvider } from './providers/pi-agent.provider';

@Module({
  imports: [SessionsPersistenceModule],
  providers: [PiAgentProvider, MockAgentProvider, AgentRegistry],
  exports: [AgentRegistry],
})
export class AgentsModule {}
