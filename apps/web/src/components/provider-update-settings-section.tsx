import { CheckCircle2, Loader2, RefreshCw, Terminal } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  fetchProviderUpdates,
  updateProviderTool,
  type ProviderToolId,
  type ProviderUpdateStatusDto,
  type ProviderUpdatesDto,
} from '../lib/provider-updates-api';

export function ProviderUpdateSettingsSection() {
  const [updates, setUpdates] = useState<ProviderUpdatesDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [updatingProvider, setUpdatingProvider] = useState<ProviderToolId | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadUpdates = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setUpdates(await fetchProviderUpdates());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load provider updates');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadUpdates();
  }, [loadUpdates]);

  const outdatedProviders = useMemo(
    () => updates?.providers.filter((provider) => provider.status === 'behind_latest') ?? [],
    [updates],
  );

  const handleUpdate = async (provider: ProviderToolId) => {
    setUpdatingProvider(provider);
    try {
      const result = await updateProviderTool(provider);
      toast.success(result.message);
      await loadUpdates();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to update provider tool');
    } finally {
      setUpdatingProvider(null);
    }
  };

  return (
    <div className="border-t border-border bg-muted/10 px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Terminal className="size-4 text-muted-foreground" />
            <span className="text-ui font-semibold text-foreground">Tool updates</span>
          </div>
          <p className="mt-1 text-ui-sm text-muted-foreground">
            Pi and Codex CLI updates are optional and never run automatically.
          </p>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="size-8 flex-shrink-0"
          onClick={() => void loadUpdates()}
          disabled={loading}
          aria-label="Refresh provider updates"
        >
          {loading ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
        </Button>
      </div>

      <div className="mt-3 space-y-2">
        {renderStatusMessage({ loading, error, updates, outdatedProviders })}
        {outdatedProviders.map((provider) => (
          <ProviderUpdateRow
            key={provider.provider}
            provider={provider}
            updating={updatingProvider === provider.provider}
            onUpdate={handleUpdate}
          />
        ))}
      </div>
    </div>
  );
}

function renderStatusMessage({
  loading,
  error,
  updates,
  outdatedProviders,
}: {
  loading: boolean;
  error: string | null;
  updates: ProviderUpdatesDto | null;
  outdatedProviders: ProviderUpdateStatusDto[];
}) {
  if (loading) {
    return <p className="text-ui-sm text-muted-foreground">Checking provider tools...</p>;
  }
  if (error) {
    return <p className="text-ui-sm text-destructive">{error}</p>;
  }
  if (updates && !updates.enabled) {
    return <p className="text-ui-sm text-muted-foreground">Provider update checks are disabled.</p>;
  }
  if (outdatedProviders.length === 0) {
    return (
      <p className="flex items-center gap-1.5 text-ui-sm text-muted-foreground">
        <CheckCircle2 className="size-3.5" />
        Pi and Codex CLI tools are up to date.
      </p>
    );
  }
  return null;
}

function ProviderUpdateRow({
  provider,
  updating,
  onUpdate,
}: {
  provider: ProviderUpdateStatusDto;
  updating: boolean;
  onUpdate: (provider: ProviderToolId) => Promise<void>;
}) {
  return (
    <div className="border-t border-border/60 pt-2">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-ui font-medium text-foreground">{provider.name} CLI update available</p>
          <p className="text-ui-sm text-muted-foreground">
            {provider.currentVersion ?? 'unknown'} -&gt; {provider.latestVersion ?? 'latest'}
          </p>
        </div>
        {provider.canUpdate && (
          <Button
            variant="outline"
            size="sm"
            className="h-8 flex-shrink-0 gap-1.5"
            onClick={() => void onUpdate(provider.provider)}
            disabled={updating}
          >
            {updating ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
            <span>Update</span>
          </Button>
        )}
      </div>
      {provider.updateCommand && (
        <code className="mt-2 block overflow-x-auto rounded-md bg-muted px-2 py-1.5 text-ui-sm text-muted-foreground">
          {provider.updateCommand}
        </code>
      )}
    </div>
  );
}
