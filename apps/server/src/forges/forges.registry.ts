import { BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { SettingsService } from '../settings/settings.service';
import { GithubForgeProvider } from './providers/github-forge.provider';
import { GitlabForgeProvider } from './providers/gitlab-forge.provider';
import type { ForgeProvider } from './forges.types';

@Injectable()
export class ForgeRegistry {
  private readonly providers: ForgeProvider[];

  constructor(
    private readonly github: GithubForgeProvider,
    private readonly gitlab: GitlabForgeProvider,
    settings: SettingsService,
  ) {
    this.providers = [this.github, this.gitlab];
    settings.onChange(() => this.bustCaches());
  }

  all(): ForgeProvider[] {
    return this.providers;
  }

  async available(): Promise<ForgeProvider[]> {
    const flags = await Promise.all(this.providers.map((provider) => provider.isAvailable()));
    return this.providers.filter((_, index) => flags[index]);
  }

  get(id: string): ForgeProvider {
    const provider = this.providers.find((item) => item.id === id);
    if (!provider) {
      throw new BadRequestException(`Unknown forge provider ${id}`);
    }
    return provider;
  }

  async getAvailable(id: string): Promise<ForgeProvider> {
    const provider = this.get(id);
    if (!(await provider.isAvailable())) {
      throw new BadRequestException(`Forge provider ${id} is not available`);
    }
    return provider;
  }

  async defaultId(): Promise<string> {
    const [provider] = await this.available();
    if (provider) return provider.id;
    throw new ServiceUnavailableException('No forge provider is configured');
  }

  bustCaches(): void {
    for (const provider of this.providers) provider.bustCache();
  }
}
