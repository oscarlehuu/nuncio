export type ProfileStatus = 'draft' | 'active' | 'retired';

/** The named wrapper/preamble sections a profile may define; all optional. */
export interface ProfileSections {
  briefWrapper?: string;
  factsWrapper?: string;
  digestWrapper?: string;
  toolsPreamble?: string;
  idioms?: string;
}

export interface PromptProfile {
  provider: string;
  modelPattern: string;
  version: number;
  status: ProfileStatus;
  /** B4: the engine's native context-file name (e.g. CLAUDE.local.md); omit if none. */
  contextFileName?: string;
  sections: ProfileSections;
}

/** The built-in pass-through profile: every wrapper is absent → canonical content unchanged. */
export const EMPTY_PROFILE: PromptProfile = {
  provider: '',
  modelPattern: '*',
  version: 0,
  status: 'active',
  sections: {},
};
