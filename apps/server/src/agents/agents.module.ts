import { Module } from '@nestjs/common';
import { SessionsPersistenceModule } from '../sessions/sessions.persistence.module';
import { AgentRegistry } from './agents.registry';
import { CursorAgentProvider } from './providers/cursor-agent.provider';
import { MockAgentProvider } from './providers/mock-agent.provider';
import { PiAgentProvider } from './providers/pi-agent.provider';

@Module({
  imports: [SessionsPersistenceModule],
  providers: [PiAgentProvider, CursorAgentProvider, MockAgentProvider, AgentRegistry],
  exports: [AgentRegistry],
})
export class AgentsModule {}
