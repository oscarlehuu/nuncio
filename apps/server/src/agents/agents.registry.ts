import { BadRequestException, Injectable } from '@nestjs/common';
import type { AgentProvider } from './agents.types';
import { CursorAgentProvider } from './providers/cursor-agent.provider';
import { MockAgentProvider } from './providers/mock-agent.provider';
import { PiAgentProvider } from './providers/pi-agent.provider';
import { SettingsService } from '../settings/settings.service';

@Injectable()
export class AgentRegistry {
  private readonly providers: AgentProvider[];

  constructor(
    private readonly pi: PiAgentProvider,
    private readonly cursor: CursorAgentProvider,
    private readonly mock: MockAgentProvider,
    settings: SettingsService,
  ) {
    this.providers = [this.pi, this.cursor, this.mock];
    // When any setting changes (e.g. a credential is rotated via the UI), drop
    // every provider's cached availability/models so the next call re-resolves
    // from the new value — no server restart required.
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

  async defaultId(): Promise<string> {
    if (await this.cursor.isAvailable()) return this.cursor.id;
    if (await this.pi.isAvailable()) return this.pi.id;
    return this.mock.id;
  }

  /** Clear cached availability/models on every provider. Called on settings change. */
  bustCaches(): void {
    for (const provider of this.providers) provider.bustCache();
  }
}
