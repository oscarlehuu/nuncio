import type { LucideIcon } from 'lucide-react';
import {
  Bot,
  FolderGit2,
  Gauge,
  GitPullRequest,
  Network,
  Palette,
  Puzzle,
  Settings2,
  SlidersHorizontal,
  Smartphone,
  UsersRound,
  Wrench,
} from 'lucide-react';

export type SettingsSectionId =
  | 'general'
  | 'appearance'
  | 'providers'
  | 'usage'
  | 'source-control'
  | 'mcp-tools'
  | 'agents'
  | 'crew-profiles'
  | 'workspaces'
  | 'projects'
  | 'mobile'
  | 'remote-access'
  | 'advanced';

export interface SettingsSectionNavItem {
  id: SettingsSectionId;
  label: string;
  icon: LucideIcon;
}

export const SETTINGS_SECTION_NAV_ITEMS: ReadonlyArray<SettingsSectionNavItem> = [
  { id: 'general', label: 'General', icon: Settings2 },
  { id: 'appearance', label: 'Appearance', icon: Palette },
  { id: 'providers', label: 'Providers', icon: Bot },
  { id: 'usage', label: 'Usage', icon: Gauge },
  { id: 'source-control', label: 'Source control', icon: GitPullRequest },
  { id: 'mcp-tools', label: 'MCP & Tools', icon: Puzzle },
  { id: 'agents', label: 'Agents', icon: SlidersHorizontal },
  { id: 'crew-profiles', label: 'Crew profiles', icon: UsersRound },
  { id: 'workspaces', label: 'Workspaces', icon: FolderGit2 },
  { id: 'projects', label: 'Projects', icon: FolderGit2 },
  { id: 'mobile', label: 'Mobile', icon: Smartphone },
  { id: 'remote-access', label: 'Remote access', icon: Network },
  { id: 'advanced', label: 'Advanced', icon: Wrench },
];

const VALID_SECTION_IDS = new Set<SettingsSectionId>(
  SETTINGS_SECTION_NAV_ITEMS.map((item) => item.id),
);

/** Legacy nav ids that now live as subsections under Providers. */
const PROVIDERS_ALIASES = new Set(['subscription-bridge', 'tool-updates']);

export const DEFAULT_SETTINGS_SECTION: SettingsSectionId = 'appearance';

/** Parse `?section=` from a search string; unknown/absent → Appearance. */
export function parseSettingsSection(search = ''): SettingsSectionId {
  const requested = new URLSearchParams(
    search.startsWith('?') ? search : search ? `?${search}` : '',
  ).get('section');
  if (requested && PROVIDERS_ALIASES.has(requested)) return 'providers';
  return requested && VALID_SECTION_IDS.has(requested as SettingsSectionId)
    ? (requested as SettingsSectionId)
    : DEFAULT_SETTINGS_SECTION;
}
