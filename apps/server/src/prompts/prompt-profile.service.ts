import { Injectable, Optional } from '@nestjs/common';
import { join } from 'node:path';
import { SettingsService } from '../settings/settings.service';
import { PromptProfileLoader } from './prompt-profile.loader';
import type { PromptProfile } from './prompt-profile.types';

/** Where the repo-shipped profile files live (apps/server/prompt-profiles). */
function repoProfilesDir(): string {
  // dist/.../prompts → up to the server package root, then prompt-profiles.
  return join(process.cwd(), 'prompt-profiles');
}

@Injectable()
export class PromptProfileService {
  private readonly loader: PromptProfileLoader;

  constructor(@Optional() private readonly settings?: SettingsService) {
    this.loader = new PromptProfileLoader(repoProfilesDir(), (key) => this.settings?.resolve(key));
  }

  resolve(provider: string, model: string | null | undefined): PromptProfile {
    return this.loader.resolve(provider, model);
  }

  /** Re-read profiles from disk/settings — called alongside the provider-registry bust. */
  bustCache(): void {
    this.loader.bustCache();
  }
}
