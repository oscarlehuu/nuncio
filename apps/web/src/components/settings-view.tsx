import {
  ArrowLeft,
  Bot,
  ChevronDown,
  ChevronUp,
  FolderGit2,
  GitPullRequest,
  Network,
  Palette,
  Puzzle,
  Search,
  Settings2,
  SlidersHorizontal,
  Gauge,
  UsersRound,
  Wrench,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useState, useEffect, type ReactNode } from 'react';
import type { Setting } from '../lib/settings-api';
import { SettingRow } from './setting-row';
import { ProviderIcon } from './provider-icon';
import { fetchForgeStatus, type ForgeStatusDto } from '../lib/forge-status-api';
import { AppearanceSettingsSection } from './appearance-settings-section';
import { ProjectsSettingsSection } from './projects-settings-section';
import { GeneralSettingsSection } from './general-settings-section';
import { RemoteAccessSettingsSection } from './remote-access-settings-section';
import { ProviderUpdateSettingsSection } from './provider-update-settings-section';
import { SubagentModelsSettingsSection } from './subagent-models-settings-section';
import { UsageSettingsSection } from './usage-settings-section';
import { SettingsSectionNav, type SettingsSectionNavItem } from './settings-section-nav';
import { CrewProfilesSettingsSection } from './crew/crew-profiles-settings-section';
import { McpServersSettingsSection } from './mcp-servers-settings-section';
import { HeartbeatHealthSection } from './heartbeat-health-section';
import { SubscriptionBridgeSettingsSection } from './subscription-bridge-settings-section';
import {
  fetchSubscriptionBridgeStatus,
  subscriptionBridgeSubtitle,
  type SubscriptionBridgeStatus,
} from '../lib/subscription-bridge-api';

interface SettingsViewProps {
  settings: Setting[];
  onUpdate: (key: string, value: string) => Promise<void>;
  onClear: (key: string) => Promise<void>;
  onBack: () => void;
}

interface ProviderMetaInfo {
  id: string;
  name: string;
  description: string;
  primaryKey: string;
}

type SettingsSectionId =
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
  | 'remote-access'
  | 'advanced';

const SECTION_NAV_ITEMS: ReadonlyArray<SettingsSectionNavItem & { id: SettingsSectionId }> = [
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
  { id: 'remote-access', label: 'Remote access', icon: Network },
  { id: 'advanced', label: 'Advanced', icon: Wrench },
];

const VALID_SECTION_IDS = new Set<SettingsSectionId>(SECTION_NAV_ITEMS.map((item) => item.id));

/**
 * Initial pane, honoring a `?section=<id>` deep-link so an external entry point
 * (the desktop tray's "Pair mobile device") can land straight on Remote access.
 * An absent or unknown value falls back to Appearance — the default landing.
 */
function initialSection(): SettingsSectionId {
  if (typeof window === 'undefined') return 'appearance';
  const requested = new URLSearchParams(window.location.search).get('section');
  return requested && VALID_SECTION_IDS.has(requested as SettingsSectionId)
    ? (requested as SettingsSectionId)
    : 'appearance';
}

const PROVIDER_METAS: Record<string, ProviderMetaInfo> = {
  cursor: {
    id: 'cursor',
    name: 'Cursor',
    description: 'Cursor local agent settings and API key',
    primaryKey: 'CURSOR_API_KEY',
  },
  pi: {
    id: 'pi',
    name: 'Nuncio Engine',
    description: 'Install or manage the Pi CLI and Nuncio Engine agent directory',
    primaryKey: 'PI_AGENT_DIR',
  },
  claude: {
    id: 'claude',
    name: 'Claude',
    description: 'Claude Agent SDK auth and default permission mode',
    primaryKey: 'ANTHROPIC_API_KEY',
  },
  codex: {
    id: 'codex',
    name: 'Codex',
    description: 'Codex CLI binary paths and runtime mode',
    primaryKey: 'NUNCIO_CODEX_BIN',
  },
  devin: {
    id: 'devin',
    name: 'Devin',
    description: 'Devin CLI (ACP) binary and default permission mode',
    primaryKey: 'NUNCIO_DEVIN_PERMISSION_MODE',
  },
  'subscription-bridge': {
    id: 'subscription-bridge',
    name: 'Subscription bridge',
    description: 'Local CLIProxy for cross-subscription models (Claude harness ↔ Codex sub)',
    primaryKey: 'NUNCIO_CLIPROXY_ENABLED',
  },
  github: {
    id: 'github',
    name: 'GitHub',
    description: 'Connect GitHub to open pull requests and synchronize issues',
    primaryKey: 'GITHUB_TOKEN',
  },
  gitlab: {
    id: 'gitlab',
    name: 'GitLab',
    description: 'Connect GitLab for merge requests and pipelines',
    primaryKey: 'GITLAB_TOKEN',
  },
};

/** AI engines + infra rows shown in Settings → Providers (Pi has no permission mode). */
const AI_PROVIDER_IDS = [
  'cursor',
  'pi',
  'claude',
  'codex',
  'devin',
  'subscription-bridge',
] as const;

// Forge automation flags live in the 'advanced' registry category but read most
// naturally beside the GitHub/GitLab connections, so they are surfaced there.
const FORGE_AUTOMATION_KEYS = new Set(['forges.autoSteer', 'forges.autoCloseOnMerge']);

function sourceControlAuthMethodSuffix(providerId: string, method: ForgeStatusDto['method']): string {
  if (method === 'token') return ' · via token';
  if (method === 'cli') return ` · via ${providerId === 'gitlab' ? 'glab' : 'gh'} CLI`;
  return '';
}

function matchesQuery(text: string | null | undefined, query: string): boolean {
  if (!query) return true;
  return (text ?? '').toLowerCase().includes(query);
}

export function SettingsView({ settings, onUpdate, onClear, onBack }: SettingsViewProps) {
  const [forgeStatus, setForgeStatus] = useState<ForgeStatusDto[]>([]);
  const [bridgeStatus, setBridgeStatus] = useState<SubscriptionBridgeStatus | null>(null);
  const [expandedProviders, setExpandedProviders] = useState<Record<string, boolean>>({});
  const [activeSection, setActiveSection] = useState<SettingsSectionId>(initialSection);
  const [searchQuery, setSearchQuery] = useState('');

  useEffect(() => {
    fetchForgeStatus()
      .then(setForgeStatus)
      .catch(() => {
        // Gracefully swallow errors so tests/unreachable server still render the view
      });
    fetchSubscriptionBridgeStatus()
      .then(setBridgeStatus)
      .catch(() => {
        // Same soft-fail as forge status — Settings still renders without live health.
      });
  }, []);

  // The Tailscale auto-trust toggle is owned by the Remote access section below.
  const general = settings.filter(
    (s) => s.category === 'general' && s.key !== 'NUNCIO_TAILSCALE_AUTO_TRUST',
  );
  // NUNCIO_SUBAGENT_MODELS is surfaced by the custom per-provider picker section,
  // not as a raw JSON string row.
  const agents = settings.filter((s) => s.category === 'agents' && s.key !== 'NUNCIO_SUBAGENT_MODELS');
  const tools = settings.filter((s) => s.category === 'tools');
  const workspaces = settings.filter((s) => s.category === 'workspaces');
  const network = settings.filter((s) => s.category === 'network' && s.key !== 'NUNCIO_TAILSCALE_AUTO_TRUST');
  const advanced = settings.filter(
    (s) => s.category === 'advanced' && !FORGE_AUTOMATION_KEYS.has(s.key),
  );
  const forgeAutomation = settings.filter((s) => FORGE_AUTOMATION_KEYS.has(s.key));
  const providerSettings = settings.filter((s) => s.category === 'provider');

  // Group by providerId
  const settingsByProvider: Record<string, Setting[]> = {};
  providerSettings.forEach((s) => {
    if (s.providerId) {
      if (!settingsByProvider[s.providerId]) {
        settingsByProvider[s.providerId] = [];
      }
      settingsByProvider[s.providerId].push(s);
    }
  });

  const toggleExpand = (providerId: string) => {
    setExpandedProviders((prev) => ({
      ...prev,
      [providerId]: !prev[providerId],
    }));
  };

  const renderProviderRow = (providerId: string, query = '') => {
    const meta = PROVIDER_METAS[providerId];
    if (!meta) return null;

    const pSettings = settingsByProvider[providerId] || [];
    if (pSettings.length === 0) return null;
    const normalizedQuery = query.trim().toLowerCase();
    if (
      normalizedQuery &&
      !matchesQuery(meta.name, normalizedQuery) &&
      !matchesQuery(meta.description, normalizedQuery) &&
      !pSettings.some((s) => matchesQuery(s.label, normalizedQuery) || matchesQuery(s.description, normalizedQuery))
    ) {
      return null;
    }

    const isSourceControl = providerId === 'github' || providerId === 'gitlab';
    let isConnected = false;
    let subtitle = meta.description;

    if (isSourceControl) {
      const status = forgeStatus.find((f) => f.id === providerId);
      isConnected = status?.connected ?? false;
      const login = status?.login;
      if (isConnected) {
        const methodSuffix = sourceControlAuthMethodSuffix(providerId, status?.method ?? null);
        subtitle = `${login ? `Connected as ${login}` : 'Connected'}${methodSuffix}`;
      } else {
        subtitle = meta.description;
      }
    } else if (providerId === 'subscription-bridge') {
      isConnected = bridgeStatus?.online ?? false;
      subtitle = subscriptionBridgeSubtitle(bridgeStatus);
    } else {
      // AI Agents
      const primarySetting = pSettings.find((s) => s.key === meta.primaryKey);
      isConnected = primarySetting?.hasValue ?? false;
    }

    // CLI-login engines always expose Manage (auth is outside the secret field).
    const alwaysManage =
      providerId === 'pi' ||
      providerId === 'claude' ||
      providerId === 'devin' ||
      providerId === 'codex' ||
      providerId === 'subscription-bridge';
    const actionLabel = alwaysManage ? 'Manage' : isConnected ? 'Manage' : 'Connect';
    const isExpanded = !!expandedProviders[providerId];

    return (
      <div key={providerId} className="border-b border-border last:border-0">
        <div className="flex items-center justify-between py-3 px-4 hover:bg-muted/40 transition-colors">
          <div className="flex items-center gap-3">
            <ProviderIcon providerId={providerId} className="size-5 text-foreground/80 flex-shrink-0" />
            <div className="flex flex-col">
              <span className="text-ui-lg font-semibold text-foreground">{meta.name}</span>
              <span className="text-ui text-muted-foreground leading-normal">{subtitle}</span>
            </div>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="h-8 font-medium px-3 text-ui flex items-center gap-1.5"
            onClick={() => toggleExpand(providerId)}
            aria-expanded={isExpanded}
            aria-label={`${actionLabel} ${meta.name}`}
          >
            <span>{actionLabel}</span>
            {isExpanded ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
          </Button>
        </div>
        {isExpanded && (
          <div className="bg-muted/20 px-4 pb-4 border-t border-border/40">
            {pSettings.map((s) => (
              <SettingRow key={s.key} setting={s} onUpdate={onUpdate} onClear={onClear} />
            ))}
            {providerId === 'subscription-bridge' && (
              <SubscriptionBridgeSettingsSection status={bridgeStatus} onStatus={setBridgeStatus} />
            )}
          </div>
        )}
      </div>
    );
  };

  const renderSettingGroup = (title: string, rows: Setting[], emptyText: string) => (
    <section>
      <h2 className="mb-2 text-ui-lg font-medium text-muted-foreground">{title}</h2>
      {rows.length > 0 ? (
        <div className="overflow-hidden rounded-lg border border-border bg-card px-4 divide-y divide-border/60">
          {rows.map((s) => (
            <SettingRow key={s.key} setting={s} onUpdate={onUpdate} onClear={onClear} />
          ))}
        </div>
      ) : (
        <div className="rounded-lg border border-border bg-card px-4 py-3 text-ui text-muted-foreground">
          {emptyText}
        </div>
      )}
    </section>
  );

  const subagentModelsValue = settings.find((s) => s.key === 'NUNCIO_SUBAGENT_MODELS')?.value ?? null;

  const renderAgentsSection = (rows: Setting[], emptyText: string) => (
    <section>
      <h2 className="mb-2 text-ui-lg font-medium text-muted-foreground">Agents</h2>
      <div className="overflow-hidden rounded-lg border border-border bg-card">
        {rows.length > 0 ? (
          <div className="px-4 divide-y divide-border/60">
            {rows.map((s) => (
              <SettingRow key={s.key} setting={s} onUpdate={onUpdate} onClear={onClear} />
            ))}
          </div>
        ) : (
          <div className="px-4 py-3 text-ui text-muted-foreground">{emptyText}</div>
        )}
        <SubagentModelsSettingsSection value={subagentModelsValue} onUpdate={onUpdate} />
      </div>
    </section>
  );

  const renderProviderGroup = (title: string, providerIds: string[], includeUpdates = false, query = '') => {
    const rows = providerIds.map((id) => renderProviderRow(id, query)).filter(Boolean);
    return (
      <section>
        <h2 className="mb-2 text-ui-lg font-medium text-muted-foreground">{title}</h2>
        {rows.length > 0 || includeUpdates ? (
          <div className="overflow-hidden rounded-lg border border-border bg-card">
            {rows}
            {includeUpdates && <ProviderUpdateSettingsSection />}
          </div>
        ) : (
          <div className="rounded-lg border border-border bg-card px-4 py-3 text-ui text-muted-foreground">
            No settings in this section.
          </div>
        )}
      </section>
    );
  };

  const filterSettings = (rows: Setting[], query: string) => {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) return rows;
    return rows.filter(
      (s) =>
        matchesQuery(s.label, normalizedQuery) ||
        matchesQuery(s.description, normalizedQuery) ||
        matchesQuery(s.key, normalizedQuery),
    );
  };

  const renderSearchResults = () => {
    const query = searchQuery.trim().toLowerCase();
    const resultSections: ReactNode[] = [];
    const remoteAccessMatches = [
      'remote access',
      'access token',
      'tailscale',
      'tailnet',
      'trust',
      'pair',
      'device',
      'qr',
      'mobile',
      'phone',
    ].some((term) => term.includes(query));

    const providerResult = renderProviderGroup('Providers', [...AI_PROVIDER_IDS], false, query);
    const sourceResult = renderProviderGroup('Source control', ['github', 'gitlab'], false, query);
    const matchingAgents = filterSettings(agents, query);
    const matchingTools = filterSettings(tools, query);
    const matchingWorkspaces = filterSettings(workspaces, query);
    const matchingNetwork = filterSettings(network, query);
    const matchingAdvanced = filterSettings(advanced, query);
    const matchingGeneral = filterSettings(general, query);
    const crewProfilesMatch = ['crew profiles', 'crew', 'foreman', 'builder', 'reviewer']
      .some((term) => term.includes(query) || query.includes(term));

    if (AI_PROVIDER_IDS.some((id) => renderProviderRow(id, query))) {
      resultSections.push(<div key="providers">{providerResult}</div>);
    }
    const matchingForgeAutomation = filterSettings(forgeAutomation, query);
    const hasSourceProviderMatch = ['github', 'gitlab'].some((id) => renderProviderRow(id, query));
    if (hasSourceProviderMatch || matchingForgeAutomation.length > 0) {
      resultSections.push(
        <div key="source-control" className="space-y-6">
          {hasSourceProviderMatch && sourceResult}
          {matchingForgeAutomation.length > 0 &&
            renderSettingGroup('Automation', matchingForgeAutomation, '')}
        </div>,
      );
    }
    // The per-provider default-model picker replaces the raw NUNCIO_SUBAGENT_MODELS
    // row, so search must match it on the section's title and key synonyms —
    // both when the query is a fragment of a synonym and vice-versa.
    const subagentModelsMatch = [
      'default subagent models',
      'subagent',
      'nuncio_subagent_models',
      'multitask',
      'agents',
    ].some((term) => term.includes(query) || query.includes(term));
    if (matchingAgents.length > 0 || subagentModelsMatch) {
      resultSections.push(<div key="agents">{renderAgentsSection(matchingAgents, '')}</div>);
    }
    if (crewProfilesMatch) resultSections.push(<div key="crew-profiles"><CrewProfilesSettingsSection /></div>);
    if (matchingTools.length > 0) {
      resultSections.push(<div key="mcp-tools">{renderSettingGroup('MCP & Tools', matchingTools, '')}</div>);
    }
    if (matchingWorkspaces.length > 0) {
      resultSections.push(<div key="workspaces">{renderSettingGroup('Workspaces', matchingWorkspaces, '')}</div>);
    }
    if (remoteAccessMatches || matchingNetwork.length > 0) {
      resultSections.push(
        <div key="remote-access" className="space-y-6">
          <RemoteAccessSettingsSection />
          {matchingNetwork.length > 0 && renderSettingGroup('Network', matchingNetwork, '')}
        </div>,
      );
    }
    if (matchingAdvanced.length > 0) {
      resultSections.push(<div key="advanced">{renderSettingGroup('Advanced', matchingAdvanced, '')}</div>);
    }
    if (matchingGeneral.length > 0) {
      resultSections.push(<div key="general">{renderSettingGroup('General', matchingGeneral, '')}</div>);
    }

    if (resultSections.length === 0) {
      return (
        <section>
          <h2 className="mb-2 text-ui-lg font-medium text-muted-foreground">Search results</h2>
          <div className="rounded-lg border border-border bg-card px-4 py-3 text-ui text-muted-foreground">
            No settings match "{searchQuery}".
          </div>
        </section>
      );
    }

    return <div className="space-y-6">{resultSections}</div>;
  };

  const renderActiveSection = () => {
    if (searchQuery.trim()) return renderSearchResults();
    switch (activeSection) {
      case 'general':
        return (
          <div className="space-y-6">
            <GeneralSettingsSection />
            {renderSettingGroup('General', general, 'No general settings are available.')}
          </div>
        );
      case 'appearance':
        return <AppearanceSettingsSection />;
      case 'providers':
        return renderProviderGroup('Providers', [...AI_PROVIDER_IDS], true);
      case 'usage':
        return <UsageSettingsSection />;
      case 'source-control':
        return (
          <div className="space-y-6">
            {renderProviderGroup('Source control', ['github', 'gitlab'])}
            {forgeAutomation.length > 0 &&
              renderSettingGroup('Automation', forgeAutomation, 'No automation settings are available.')}
          </div>
        );
      case 'mcp-tools':
        return (
          <div className="space-y-6">
            <McpServersSettingsSection />
            {renderSettingGroup('Tools', tools, 'No tool settings are available.')}
          </div>
        );
      case 'agents':
        return renderAgentsSection(agents, 'No agent defaults are available.');
      case 'crew-profiles':
        return <CrewProfilesSettingsSection />;
      case 'workspaces':
        return renderSettingGroup('Workspaces', workspaces, 'No workspace settings are available.');
      case 'projects':
        return <ProjectsSettingsSection />;
      case 'remote-access':
        return (
          <div className="space-y-6">
            <RemoteAccessSettingsSection />
            {network.length > 0 && renderSettingGroup('Network', network, 'No network settings are available.')}
          </div>
        );
      case 'advanced':
        return (
          <div className="space-y-6">
            {renderSettingGroup('Advanced', advanced, 'No advanced settings are available.')}
            <HeartbeatHealthSection />
          </div>
        );
      default: {
        const _exhaustive: never = activeSection;
        return _exhaustive;
      }
    }
  };

  const handleSectionSelect = (sectionId: string) => {
    setActiveSection(sectionId as SettingsSectionId);
    setSearchQuery('');
  };

  return (
    <section className="flex-1 flex flex-col min-h-0 overflow-hidden bg-background">
      <header className="flex items-center gap-2 px-4 py-3 border-b border-border sticky top-0 bg-background z-10">
        <Button variant="ghost" size="icon" onClick={onBack} aria-label="Back">
          <ArrowLeft className="size-4" />
        </Button>
        <h1 className="text-lg font-semibold tracking-tight">Settings</h1>
      </header>

      <div className="flex flex-1 min-h-0 flex-col sm:flex-row">
        <aside className="shrink-0 border-b border-border bg-sidebar/40 sm:w-60 sm:border-b-0 sm:border-r">
          <div className="p-2 sm:p-3">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                type="search"
                role="searchbox"
                aria-label="Search settings"
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                placeholder="Search Settings"
                className="h-8 pl-8 text-ui"
              />
            </div>
          </div>
          <SettingsSectionNav items={SECTION_NAV_ITEMS} activeId={activeSection} onSelect={handleSectionSelect} />
        </aside>

        <div className="flex-1 overflow-y-auto px-4 py-5">
          <div className="mx-auto w-full max-w-[720px] space-y-6">
            {renderActiveSection()}
            <p className="text-ui-sm text-muted-foreground leading-relaxed pt-2">
              Settings override environment variables at runtime. Secrets are encrypted at rest
              (AES-256-GCM) and never returned in plain text. Boot-only vars (NUNCIO_DATA_DIR, PORT,
              NUNCIO_SETTINGS_KEY) remain env-only.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
