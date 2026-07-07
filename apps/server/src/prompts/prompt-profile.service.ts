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
    // its key is added to the registry — must fall through to pass-through, not
    // crash session creation. settings.resolve() throws on an UNREGISTERED key
    // by design (a typo guard). Gate the lookup on registry membership
    // (settings.get() returns null for an unknown key and never throws) instead
    // of swallowing resolve()'s throw: a genuine resolution failure on a
    // REGISTERED key must still propagate, never silently degrade to
    // pass-through.
    this.loader = new PromptProfileLoader(repoProfilesDir(), (key) => {
      if (!this.settings || this.settings.get(key) === null) return undefined;
      return this.settings.resolve(key);
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
