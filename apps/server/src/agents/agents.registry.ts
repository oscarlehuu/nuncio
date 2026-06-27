import { BadRequestException, Injectable } from '@nestjs/common';
import type { AgentProvider } from './agents.types';
import { MockAgentProvider } from './providers/mock-agent.provider';
import { PiAgentProvider } from './providers/pi-agent.provider';

@Injectable()
export class AgentRegistry {
  private readonly providers: AgentProvider[];

  constructor(
    private readonly pi: PiAgentProvider,
    private readonly mock: MockAgentProvider,
  ) {
    this.providers = [this.pi, this.mock];
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
    return (await this.pi.isAvailable()) ? this.pi.id : this.mock.id;
  }
}
