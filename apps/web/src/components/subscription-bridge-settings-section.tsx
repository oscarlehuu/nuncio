import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Copy, RefreshCw, Search } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  adoptExternalSubscriptionBridge,
  discoverSubscriptionBridgeInstalls,
  fetchSubscriptionBridgeClaudeCodeEnv,
  initManagedSubscriptionBridge,
  migrateManagedSubscriptionBridge,
  refreshSubscriptionBridgeStatus,
  startManagedSubscriptionBridge,
  stopManagedSubscriptionBridge,
  type SubscriptionBridgeDiscoveryInstall,
  type SubscriptionBridgeStatus,
} from '../lib/subscription-bridge-api';

interface SubscriptionBridgeSettingsSectionProps {
  status: SubscriptionBridgeStatus | null;
  onStatus: (status: SubscriptionBridgeStatus) => void;
}

export function SubscriptionBridgeSettingsSection({
  status,
  onStatus,
}: SubscriptionBridgeSettingsSectionProps) {
  const [busy, setBusy] = useState<string | null>(null);
  const [installs, setInstalls] = useState<SubscriptionBridgeDiscoveryInstall[]>([]);

  const handleRefresh = useCallback(async () => {
    setBusy('refresh');
    try {
      const next = await refreshSubscriptionBridgeStatus();
      onStatus(next);
      toast.success(next.online ? 'Subscription bridge online' : 'Subscription bridge offline');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Refresh failed');
    } finally {
      setBusy(null);
    }
  }, [onStatus]);

  const handleDiscover = useCallback(async () => {
    setBusy('discover');
    try {
      const found = await discoverSubscriptionBridgeInstalls();
      setInstalls(found);
      toast.success(
        found.length === 0
          ? 'No CLIProxyAPI config found on this Mac'
          : `Found ${found.length} CLIProxyAPI install${found.length === 1 ? '' : 's'}`,
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Discover failed');
    } finally {
      setBusy(null);
    }
  }, []);

  useEffect(() => {
    void discoverSubscriptionBridgeInstalls()
      .then(setInstalls)
      .catch(() => {
        // Soft-fail — Discover button remains available.
      });
  }, []);

  const handleCopyEnv = useCallback(async () => {
    setBusy('copy');
    try {
      const dto = await fetchSubscriptionBridgeClaudeCodeEnv();
      if (!dto.env.ANTHROPIC_AUTH_TOKEN) {
        toast.error('Set the CLIProxyAPI API key before copying env');
        return;
      }
      await navigator.clipboard.writeText(dto.exports);
      toast.success('Copied Claude Code env exports');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Copy failed');
    } finally {
      setBusy(null);
    }
  }, []);

  const runAction = useCallback(
    async (id: string, action: () => Promise<SubscriptionBridgeStatus>, ok: string) => {
      setBusy(id);
      try {
        const next = await action();
        onStatus(next);
        toast.success(ok);
      } catch (error) {
        toast.error(error instanceof Error ? error.message : 'Action failed');
      } finally {
        setBusy(null);
      }
    },
    [onStatus],
  );

  const mode = status?.mode ?? 'external';

  return (
    <div className="flex flex-col gap-4">
      <p className="text-ui text-muted-foreground leading-normal">
        Not a separate engine. Route Claude-session GPT models through local CLIProxyAPI (Codex sub).
        Native Codex engine sessions stay unchanged.
      </p>

      <div className="grid gap-3">
        <ModeCard
          title="1. Existing CLIProxyAPI"
          body="Discover a CLIProxyAPI you already run. Connect in place (external), or migrate the config into Nuncio’s data dir (managed, default port 18317)."
          active={mode === 'external' || (mode === 'managed' && installs.length > 0)}
        >
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8"
            disabled={busy !== null}
            onClick={() => void handleDiscover()}
            aria-label="Discover CLIProxyAPI installs"
          >
            <Search className="size-3.5" data-icon="inline-start" />
            {busy === 'discover' ? 'Scanning…' : 'Discover'}
          </Button>
          {installs.map((install) => (
            <div
              key={install.configPath}
              className="rounded-md border border-border/60 bg-background/60 px-3 py-2 text-ui-sm space-y-2"
            >
              <div className="font-mono text-muted-foreground break-all">{install.configPath}</div>
              <div className="text-muted-foreground">
                {install.baseUrl ?? 'no port'} · keys {install.apiKeys.length} · Claude{' '}
                {install.accounts.claude ? 'yes' : 'no'} · Codex {install.accounts.codex ? 'yes' : 'no'}
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-8"
                  disabled={busy !== null}
                  onClick={() =>
                    void runAction(
                      `adopt:${install.configPath}`,
                      () =>
                        adoptExternalSubscriptionBridge({
                          configPath: install.configPath,
                          apiKeyIndex: 0,
                        }),
                      'Connected to external CLIProxyAPI',
                    )
                  }
                >
                  Use as external
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-8"
                  disabled={busy !== null}
                  onClick={() =>
                    void runAction(
                      `migrate:${install.configPath}`,
                      () =>
                        migrateManagedSubscriptionBridge({
                          configPath: install.configPath,
                        }),
                      'Migrated into Nuncio-managed CLIProxyAPI',
                    )
                  }
                >
                  Migrate into Nuncio
                </Button>
              </div>
            </div>
          ))}
        </ModeCard>

        <ModeCard
          title="2. Fresh managed"
          body="Happy path — generate a new Nuncio-owned config, then run Claude/Codex login from the hints below."
          active={mode === 'managed' && !installs.length}
        >
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8"
            disabled={busy !== null}
            onClick={() =>
              void runAction('init', () => initManagedSubscriptionBridge(), 'Initialized managed CLIProxyAPI')
            }
            aria-label="Initialize managed CLIProxyAPI"
          >
            {busy === 'init' ? 'Initializing…' : 'Initialize managed'}
          </Button>
        </ModeCard>
      </div>

      {status?.mode === 'managed' && (
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8"
            disabled={busy !== null || status.managed.running}
            onClick={() =>
              void runAction('start', () => startManagedSubscriptionBridge(), 'Managed CLIProxyAPI started')
            }
          >
            Start
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8"
            disabled={busy !== null || !status.managed.running}
            onClick={() =>
              void runAction('stop', () => stopManagedSubscriptionBridge(), 'Managed CLIProxyAPI stopped')
            }
          >
            Stop
          </Button>
          {status.managed.configPath && (
            <span className="self-center font-mono text-ui-sm text-muted-foreground break-all">
              {status.managed.configPath}
              {status.managed.port != null ? ` · :${status.managed.port}` : ''}
            </span>
          )}
        </div>
      )}

      {status?.loginHints && (
        <div className="rounded-md border border-border/60 bg-background/60 px-3 py-2 font-mono text-ui-sm text-muted-foreground space-y-1">
          <div>Claude login: {status.loginHints.claude}</div>
          <div>Codex login: {status.loginHints.codex}</div>
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-8"
          disabled={busy !== null}
          onClick={() => void handleRefresh()}
          aria-label="Check Subscription bridge health"
        >
          <RefreshCw className="size-3.5" data-icon="inline-start" />
          {busy === 'refresh' ? 'Checking…' : 'Check health'}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-8"
          disabled={busy !== null}
          onClick={() => void handleCopyEnv()}
          aria-label="Copy Claude Code env for Subscription bridge"
        >
          <Copy className="size-3.5" data-icon="inline-start" />
          {busy === 'copy' ? 'Copying…' : 'Copy Claude Code env'}
        </Button>
      </div>
    </div>
  );
}

function ModeCard({
  title,
  body,
  active,
  children,
}: {
  title: string;
  body: string;
  active?: boolean;
  children?: ReactNode;
}) {
  return (
    <div
      className={
        active
          ? 'rounded-lg border border-primary/30 bg-primary/5 px-3 py-3 space-y-2'
          : 'rounded-lg border border-border/60 bg-muted/10 px-3 py-3 space-y-2'
      }
    >
      <div className="text-ui font-semibold text-foreground">{title}</div>
      <p className="text-ui-sm text-muted-foreground leading-normal">{body}</p>
      {children}
    </div>
  );
}
