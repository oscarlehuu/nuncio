import { BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import type { AgentProvider } from './agents.types';
import { CodexAgentProvider } from './providers/codex-agent.provider';
import { CursorAgentProvider } from './providers/cursor-agent.provider';
import { CursorCliProvider } from './providers/cursor-cli.provider';
import { PiAgentProvider } from './providers/pi-agent.provider';
import { SettingsService } from '../settings/settings.service';
import type { SessionDto } from '../sessions/domain/sessions.types';

@Injectable()
export class AgentRegistry {
  private readonly providers: AgentProvider[];
  private readonly cliProvider: CursorCliProvider;

  constructor(
    private readonly pi: PiAgentProvider,
    private readonly cursor: CursorAgentProvider,
    private readonly codex: CodexAgentProvider,
    cli: CursorCliProvider,
    settings: SettingsService,
  ) {
    this.cliProvider = cli;
    this.providers = [this.pi, this.cursor, this.codex];
    settings.onChange(() => this.bustCaches());
  }

  all(): AgentProvider[] {
    return this.providers;
  }

  async available(): Promise<AgentProvider[]> {
    const flags = await Promise.all(this.providers.map((provider) => provider.isAvailable()));
    return this.providers.filter((_, index) => flags[index]);
  }

  get(id: string): AgentProvider {
    if (id === this.cliProvider.id) return this.cliProvider;
    const provider = this.providers.find((item) => item.id === id);
    if (!provider) {
      throw new BadRequestException(`Unknown agent provider ${id}`);
    }
    return provider;
  }

  async getAvailable(id: string): Promise<AgentProvider> {
    const provider = this.get(id);
    if (!(await provider.isAvailable())) {
      throw new BadRequestException(`Agent provider ${id} is not available`);
    }
    return provider;
  }

  /** Route handoff (cli) vs normal (sdk) sessions to the correct runtime. */
  resolveForSession(session: SessionDto): AgentProvider {
    if (session.cursorBackend === 'cli') return this.cliProvider;
    return this.get(session.provider);
  }

  async resolveAvailableForSession(session: SessionDto): Promise<AgentProvider> {
    const provider = this.resolveForSession(session);
    if (!(await provider.isAvailable())) {
      throw new BadRequestException(`Agent provider ${provider.id} is not available`);
    }
    return provider;
  }

  cli(): CursorCliProvider {
    return this.cliProvider;
  }

  async defaultId(): Promise<string> {
    if (await this.cursor.isAvailable()) return this.cursor.id;
    if (await this.codex.isAvailable()) return this.codex.id;
    if (await this.pi.isAvailable()) return this.pi.id;
    throw new ServiceUnavailableException('No agent provider is configured');
  }

  bustCaches(): void {
    for (const provider of this.providers) provider.bustCache();
  }
}
