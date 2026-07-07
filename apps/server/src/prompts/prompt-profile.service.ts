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
    // The loader asks for a per-provider override key it derives from the
    // provider id (NUNCIO_PROMPT_PROFILE_<PROVIDER>). Providers without a
    // registered override key — the test-only mock, and any new engine before
    // its key is added to the registry — must fall through to the repo profile
    // / pass-through default, not crash session creation. settings.resolve()
    // throws on an unregistered key by design (a typo guard), so treat that
    // throw here as "no override present" rather than letting it escape.
    this.loader = new PromptProfileLoader(repoProfilesDir(), (key) => {
      try {
        return this.settings?.resolve(key);
      } catch {
        return undefined;
      }
    });
    // Settings changes (e.g. NUNCIO_PROMPT_PROFILE_<PROVIDER>) must take effect
    // without a restart — same mechanism as AgentRegistry's provider-cache bust.
    this.settings?.onChange(() => this.bustCache());
  }

  resolve(provider: string, model: string | null | undefined): PromptProfile {
    return this.loader.resolve(provider, model);
  }

  /** Re-read profiles from disk/settings — self-subscribed to settings changes. */
  bustCache(): void {
    this.loader.bustCache();
  }
}
