import { Module } from '@nestjs/common';
import { SessionsPersistenceModule } from '../sessions/sessions.persistence.module';
import { SettingsModule } from '../settings/settings.module';
import { AgentRegistry } from './agents.registry';
import { CursorAgentProvider } from './providers/cursor-agent.provider';
import { CursorCliProvider } from './providers/cursor-cli.provider';
import { CodexAgentProvider } from './providers/codex-agent.provider';
import { PiAgentProvider } from './providers/pi-agent.provider';

@Module({
  imports: [SessionsPersistenceModule, SettingsModule],
  providers: [PiAgentProvider, CursorAgentProvider, CodexAgentProvider, CursorCliProvider, AgentRegistry],
  exports: [AgentRegistry],
})
export class AgentsModule {}
