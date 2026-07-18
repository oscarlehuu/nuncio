import { Module, type Provider } from '@nestjs/common';
import { SessionsPersistenceModule } from '../sessions/sessions.persistence.module';
import { SettingsModule } from '../settings/settings.module';
import { ContextModule } from '../context/context.module';
import { EvidenceModule } from '../evidence/evidence.module';
import {
  NuncioContextRepository,
  NuncioContextService,
} from './pi-engine/nuncio-context';
import { ExternalMemorySources } from './pi-engine/external-memory-sources';
import { ExternalMemoriesService } from './pi-engine/external-memories';
import { AgentRegistry } from './agents.registry';
import { CursorAgentProvider } from './providers/cursor-agent.provider';
import { CursorCliProvider } from './providers/cursor-cli.provider';
import { CodexAgentProvider } from './providers/codex-agent.provider';
import { ClaudeAgentProvider } from './providers/claude-agent.provider';
import { PiAgentProvider } from './providers/pi-agent.provider';
import { MockAgentProvider } from './providers/mock-agent.provider';
import { MOCK_AGENT_PROVIDER } from './mock-agent.token';

// The zero-credential Mock provider is opt-in: `MockAgentProvider` is always in
// the DI container, but it is bound under `MOCK_AGENT_PROVIDER` — the token the
// registry actually reads — only when the operator sets `NUNCIO_FORCE_MOCK=1`.
// Packaged desktop builds set `NUNCIO_PACKAGED=1`; that hard-disables Mock even
// if test residue leaves `NUNCIO_FORCE_MOCK=1` in the parent environment. So a
// normal or packaged boot never registers it and it can never be selected or
// leak into the model picker. The env check runs at module-init (factory) time
// rather than at import time so it honors the flag regardless of import order
// (unit tests set it per-case). Only the exact value "1" enables it from source.
// The scripted level-5 UI smoke sets the flag to drive create/stream/steer/archive
// offline.
let warnedPackagedMockBlocked = false;

function shouldRegisterMockProvider(): boolean {
  if (process.env.NUNCIO_FORCE_MOCK !== '1') return false;
  if (process.env.NUNCIO_PACKAGED !== '1') return true;

  if (!warnedPackagedMockBlocked) {
    warnedPackagedMockBlocked = true;
    console.warn(
      '[agents] ignoring NUNCIO_FORCE_MOCK because NUNCIO_PACKAGED=1; mock provider will not register',
    );
  }
  return false;
}

const mockProviderBinding: Provider = {
  provide: MOCK_AGENT_PROVIDER,
  inject: [MockAgentProvider],
  useFactory: (mock: MockAgentProvider) => (shouldRegisterMockProvider() ? mock : null),
};

@Module({
  imports: [SessionsPersistenceModule, SettingsModule, ContextModule, EvidenceModule],
  providers: [
    PiAgentProvider,
    CursorAgentProvider,
    CodexAgentProvider,
    ClaudeAgentProvider,
    CursorCliProvider,
    MockAgentProvider,
    NuncioContextRepository,
    NuncioContextService,
    ExternalMemorySources,
    ExternalMemoriesService,
    mockProviderBinding,
    AgentRegistry,
  ],
  exports: [AgentRegistry],
})
export class AgentsModule {}
