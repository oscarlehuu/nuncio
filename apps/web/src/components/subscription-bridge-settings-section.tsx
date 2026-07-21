import { useCallback, useState } from 'react';
import { Copy, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  fetchSubscriptionBridgeClaudeCodeEnv,
  refreshSubscriptionBridgeStatus,
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
  const [busy, setBusy] = useState<'refresh' | 'copy' | null>(null);

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

  const handleCopyEnv = useCallback(async () => {
    setBusy('copy');
    try {
      const dto = await fetchSubscriptionBridgeClaudeCodeEnv();
      if (!dto.env.ANTHROPIC_AUTH_TOKEN) {
        toast.error('Set the CLIProxy API key before copying env');
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

  return (
    <div className="flex flex-col gap-3 border-t border-border/40 pt-3 mt-1">
      <p className="text-ui text-muted-foreground leading-normal">
        Not a separate engine. Enable the bridge, then pick a Claude session and a GPT model
        (badge Codex sub). Native Codex engine sessions are unchanged.
      </p>
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
