import { ArrowLeft, ChevronDown, ChevronUp } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useState, useEffect } from 'react';
import type { Setting } from '../lib/settings-api';
import { SettingRow } from './setting-row';
import { ProviderIcon } from './provider-icon';
import { fetchForgeStatus, type ForgeStatusDto } from '../lib/forge-status-api';

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

const PROVIDER_METAS: Record<string, ProviderMetaInfo> = {
  cursor: {
    id: 'cursor',
    name: 'Cursor',
    description: 'Cursor local agent settings and API key',
    primaryKey: 'CURSOR_API_KEY',
  },
  pi: {
    id: 'pi',
    name: 'Pi',
    description: 'Pi coding agent settings and configuration directory',
    primaryKey: 'PI_AGENT_DIR',
  },
  codex: {
    id: 'codex',
    name: 'Codex',
    description: 'Codex CLI binary paths and options',
    primaryKey: 'NUNCIO_CODEX_BIN',
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

function sourceControlAuthMethodSuffix(providerId: string, method: ForgeStatusDto['method']): string {
  if (method === 'token') return ' · via token';
  if (method === 'cli') return ` · via ${providerId === 'gitlab' ? 'glab' : 'gh'} CLI`;
  return '';
}

export function SettingsView({ settings, onUpdate, onClear, onBack }: SettingsViewProps) {
  const [forgeStatus, setForgeStatus] = useState<ForgeStatusDto[]>([]);
  const [expandedProviders, setExpandedProviders] = useState<Record<string, boolean>>({});

  useEffect(() => {
    fetchForgeStatus()
      .then(setForgeStatus)
      .catch(() => {
        // Gracefully swallow errors so tests/unreachable server still render the view
      });
  }, []);

  const general = settings.filter((s) => s.category === 'general');
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

  const renderProviderRow = (providerId: string) => {
    const meta = PROVIDER_METAS[providerId];
    if (!meta) return null;

    const pSettings = settingsByProvider[providerId] || [];
    if (pSettings.length === 0) return null;

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
    } else {
      // AI Agents
      const primarySetting = pSettings.find((s) => s.key === meta.primaryKey);
      isConnected = primarySetting?.hasValue ?? false;
    }

    const isExpanded = !!expandedProviders[providerId];

    return (
      <div key={providerId} className="border-b border-border last:border-0">
        <div className="flex items-center justify-between py-3 px-4 hover:bg-muted/40 transition-colors">
          <div className="flex items-center gap-3">
            <ProviderIcon providerId={providerId} className="size-5 text-foreground/80 flex-shrink-0" />
            <div className="flex flex-col">
              <span className="text-[13.5px] font-semibold text-foreground">{meta.name}</span>
              <span className="text-[12px] text-muted-foreground leading-normal">{subtitle}</span>
            </div>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="h-8 font-medium px-3 text-[12px] flex items-center gap-1.5"
            onClick={() => toggleExpand(providerId)}
            aria-expanded={isExpanded}
            aria-label={`${isConnected ? 'Manage' : 'Connect'} ${meta.name}`}
          >
            <span>{isConnected ? 'Manage' : 'Connect'}</span>
            {isExpanded ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
          </Button>
        </div>
        {isExpanded && (
          <div className="bg-muted/20 px-4 pb-4 border-t border-border/40">
            {pSettings.map((s) => (
              <SettingRow key={s.key} setting={s} onUpdate={onUpdate} onClear={onClear} />
            ))}
          </div>
        )}
      </div>
    );
  };

  return (
    <section className="flex-1 flex flex-col min-h-0 overflow-y-auto">
      <header className="flex items-center gap-2 px-4 py-3 border-b border-border sticky top-0 bg-background z-10">
        <Button variant="ghost" size="icon" onClick={onBack} aria-label="Back">
          <ArrowLeft className="size-4" />
        </Button>
        <h1 className="text-[16px] font-semibold tracking-tight">Settings</h1>
      </header>

      <div className="flex-1 px-4 py-2 max-w-[640px] w-full mx-auto space-y-6">
        {/* Providers Section */}
        <section className="mt-4 first:mt-0">
          <h2 className="text-[10px] uppercase tracking-widest text-muted-foreground font-semibold mb-2">
            Providers
          </h2>
          <div className="border border-border rounded-lg overflow-hidden bg-card">
            {['cursor', 'pi', 'codex'].map((id) => renderProviderRow(id))}
          </div>
        </section>

        {/* Source Control Section */}
        <section>
          <h2 className="text-[10px] uppercase tracking-widest text-muted-foreground font-semibold mb-2">
            Source Control
          </h2>
          <div className="border border-border rounded-lg overflow-hidden bg-card">
            {['github', 'gitlab'].map((id) => renderProviderRow(id))}
          </div>
        </section>

        {/* General Section */}
        {general.length > 0 && (
          <section>
            <h2 className="text-[10px] uppercase tracking-widest text-muted-foreground font-semibold mb-2">
              General
            </h2>
            <div className="border border-border rounded-lg overflow-hidden bg-card px-4 divide-y divide-border/60">
              {general.map((s) => (
                <SettingRow key={s.key} setting={s} onUpdate={onUpdate} onClear={onClear} />
              ))}
            </div>
          </section>
        )}

        <p className="text-[11px] text-muted-foreground leading-relaxed pt-2">
          Settings override environment variables at runtime. Secrets are encrypted at rest
          (AES-256-GCM) and never returned in plain text. Boot-only vars (NUNCIO_DATA_DIR, PORT,
          NUNCIO_SETTINGS_KEY) remain env-only.
        </p>
      </div>
    </section>
  );
}
