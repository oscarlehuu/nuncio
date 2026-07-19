import { useCallback, useEffect, useState } from 'react';
import { ChevronDown, ChevronUp, Globe, SquareTerminal } from 'lucide-react';
import { toast } from 'sonner';
import {
  applyMcpImport,
  deleteMcpServer,
  fetchMcpServers,
  previewMcpImport,
  startMcpOAuth,
  updateMcpServer,
  type McpImportPreview,
  type McpImportSource,
  type McpOAuthStatus,
  type McpServerDto,
  type McpTransport,
} from '../lib/mcp-servers-api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

const IMPORT_SOURCES: Array<{ id: McpImportSource; label: string }> = [
  { id: 'cursor', label: 'Cursor' },
  { id: 'claude', label: 'Claude Code' },
  { id: 'codex', label: 'Codex' },
];

/**
 * MCP Store management: the registry of external MCP servers every engine can
 * use through the lazy gateway. Servers arrive mainly via one-click import
 * from the Cursor / Claude Code / Codex stores; each row can be toggled,
 * switched between lazy/full advertising, or removed.
 */
export function McpServersSettingsSection() {
  const [servers, setServers] = useState<McpServerDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [preview, setPreview] = useState<McpImportPreview | null>(null);
  const [importing, setImporting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<McpServerDto | null>(null);

  const refresh = useCallback(async () => {
    try {
      setServers(await fetchMcpServers());
    } catch {
      // Section renders empty when the endpoint is unreachable (tests / offline).
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const params = new URLSearchParams(window.location.search);
    if (params.get('mcp_oauth') === 'ok') {
      toast.success('MCP server connected');
      params.delete('mcp_oauth');
      const next = `${window.location.pathname}${params.toString() ? `?${params}` : ''}`;
      window.history.replaceState({}, '', next);
      void refresh();
    }
  }, [refresh]);

  const handlePreview = async (source: McpImportSource) => {
    try {
      setPreview(await previewMcpImport(source));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Import scan failed');
    }
  };

  const handleApplyImport = async () => {
    if (!preview) return;
    setImporting(true);
    try {
      const result = await applyMcpImport(preview.source);
      toast.success(
        `Imported ${result.createdIds.length} server${result.createdIds.length === 1 ? '' : 's'}` +
          (result.mergedIds.length > 0 ? ` (${result.mergedIds.length} merged)` : ''),
      );
      setPreview(null);
      await refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Import failed');
    } finally {
      setImporting(false);
    }
  };

  const handlePatch = async (
    server: McpServerDto,
    patch: Parameters<typeof updateMcpServer>[1],
  ) => {
    try {
      const updated = await updateMcpServer(server.id, patch);
      setServers((current) => current.map((entry) => (entry.id === server.id ? updated : entry)));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Update failed');
    }
  };

  const handleDelete = async () => {
    if (!confirmDelete) return;
    try {
      await deleteMcpServer(confirmDelete.id);
      toast.success(`Removed ${confirmDelete.name}`);
      setConfirmDelete(null);
      await refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Delete failed');
    }
  };

  return (
    <section>
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 className="text-ui-lg font-medium text-muted-foreground">MCP servers</h2>
        <div className="flex items-center gap-1.5">
          {IMPORT_SOURCES.map((source) => (
            <Button
              key={source.id}
              variant="outline"
              size="sm"
              onClick={() => void handlePreview(source.id)}
              aria-label={`Import from ${source.label}`}
            >
              {source.label}
            </Button>
          ))}
        </div>
      </div>
      <p className="mb-3 text-ui text-muted-foreground leading-relaxed">
        External MCP servers available to every engine. Sessions see a compact inventory and load a
        server's tools only when they use it, so enabled servers cost almost no context. Import
        pulls from the store's config files without changing them.
      </p>

      {loading ? (
        <div className="rounded-lg border border-border bg-card px-4 py-3 text-ui text-muted-foreground">
          Loading MCP servers…
        </div>
      ) : servers.length === 0 ? (
        <div className="rounded-lg border border-border bg-card px-4 py-3 text-ui text-muted-foreground leading-relaxed">
          No MCP servers yet. Import your existing setup from Cursor, Claude Code, or Codex with
          the buttons above.
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-border bg-card divide-y divide-border/60">
          {servers.map((server) => (
            <McpServerRow
              key={server.id}
              server={server}
              expanded={expanded === server.id}
              onToggleExpand={() => setExpanded(expanded === server.id ? null : server.id)}
              onPatch={(patch) => void handlePatch(server, patch)}
              onDelete={() => setConfirmDelete(server)}
              onRefresh={refresh}
            />
          ))}
        </div>
      )}

      <ImportPreviewDialog
        preview={preview}
        importing={importing}
        onCancel={() => setPreview(null)}
        onConfirm={() => void handleApplyImport()}
      />

      <Dialog open={confirmDelete !== null} onOpenChange={(open) => !open && setConfirmDelete(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove {confirmDelete?.name}?</DialogTitle>
            <DialogDescription>
              Sessions will no longer see this server. The original entry in the source store
              config is not touched, so you can re-import it later.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmDelete(null)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={() => void handleDelete()}>
              Remove
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

function McpServerRow({
  server,
  expanded,
  onToggleExpand,
  onPatch,
  onDelete,
  onRefresh,
}: {
  server: McpServerDto;
  expanded: boolean;
  onToggleExpand: () => void;
  onPatch: (patch: Parameters<typeof updateMcpServer>[1]) => void;
  onDelete: () => void;
  onRefresh: () => Promise<void>;
}) {
  const [connecting, setConnecting] = useState(false);
  const Icon = server.transport.type === 'stdio' ? SquareTerminal : Globe;

  const handleConnect = async () => {
    setConnecting(true);
    try {
      const result = await startMcpOAuth(server.id, window.location.origin);
      if (result.alreadyAuthorized) {
        toast.success(`${server.name} is already connected`);
        await onRefresh();
        return;
      }
      if (result.authorizationUrl) {
        window.open(result.authorizationUrl, '_blank', 'noopener,noreferrer');
        toast.message('Complete authorization in the new tab, then return here.');
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'OAuth start failed');
    } finally {
      setConnecting(false);
    }
  };

  const oauthLabel = (status: McpOAuthStatus): string => {
    switch (status) {
      case 'connected':
        return 'Reconnect';
      case 'required':
        return 'Connect';
      default:
        return 'Connect';
    }
  };
  return (
    <div>
      <div className="flex items-center justify-between gap-3 px-4 py-3 hover:bg-muted/40 transition-colors">
        <div className="flex min-w-0 items-center gap-3">
          <Icon className="size-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-ui-lg font-medium text-foreground truncate">{server.name}</span>
              {server.scope === 'project' && (
                <Badge variant="outline" className="font-normal">
                  Project
                </Badge>
              )}
              {server.auth === 'oauth' && (
                <Badge variant="outline" className="font-normal">
                  OAuth
                </Badge>
              )}
            </div>
            <div className="text-ui-sm text-muted-foreground truncate">{rowSubtitle(server)}</div>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {server.auth === 'oauth' && (
            <Button
              variant="outline"
              size="sm"
              disabled={connecting}
              onClick={() => void handleConnect()}
              aria-label={`${oauthLabel(server.oauthStatus)} ${server.name}`}
            >
              {connecting ? 'Opening…' : oauthLabel(server.oauthStatus)}
            </Button>
          )}
          <Switch
            checked={server.enabled}
            onCheckedChange={(checked) => onPatch({ enabled: checked })}
            aria-label={`Enable ${server.name}`}
          />
          <Button
            variant="outline"
            size="sm"
            onClick={onToggleExpand}
            aria-expanded={expanded}
            aria-label={`Manage ${server.name}`}
          >
            <span>Manage</span>
            {expanded ? <ChevronUp data-icon="inline-end" /> : <ChevronDown data-icon="inline-end" />}
          </Button>
        </div>
      </div>
      {expanded && (
        <div className="space-y-3 border-t border-border/40 bg-muted/20 px-4 py-3">
          <div className="text-ui-sm text-muted-foreground break-all">
            {transportDetail(server.transport)}
          </div>
          {server.projectPath && (
            <div className="text-ui-sm text-muted-foreground break-all">
              Scoped to {server.projectPath}
            </div>
          )}
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-ui font-medium text-foreground">Advertise tools directly</div>
              <div className="text-ui-sm text-muted-foreground leading-normal">
                Expose every tool schema to sessions instead of the lazy gateway. Costs context
                each turn; use for small, frequently-used servers.
              </div>
            </div>
            <Switch
              checked={server.advertise === 'full'}
              onCheckedChange={(checked) => onPatch({ advertise: checked ? 'full' : 'lazy' })}
              aria-label="Advertise tools directly"
            />
          </div>
          <div className="flex justify-end">
            <Button variant="destructive" size="sm" onClick={onDelete} aria-label={`Remove ${server.name}`}>
              Remove
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function ImportPreviewDialog({
  preview,
  importing,
  onCancel,
  onConfirm,
}: {
  preview: McpImportPreview | null;
  importing: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const newCount = preview?.entries.filter((entry) => entry.status === 'new').length ?? 0;
  const sourceLabel = IMPORT_SOURCES.find((s) => s.id === preview?.source)?.label ?? preview?.source;
  return (
    <Dialog open={preview !== null} onOpenChange={(open) => !open && onCancel()}>
      <DialogContent className="max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Import from {sourceLabel}</DialogTitle>
          <DialogDescription>
            {preview?.entries.length === 0
              ? 'No MCP servers found in this store.'
              : `Found ${preview?.entries.length} server${preview?.entries.length === 1 ? '' : 's'} — ${newCount} new. Secrets are encrypted at rest; the source config stays untouched.`}
          </DialogDescription>
        </DialogHeader>
        <div className="divide-y divide-border/60 rounded-lg border border-border">
          {preview?.entries.map((entry, index) => (
            <div
              key={`${index}:${entry.candidate.name}`}
              className="flex items-center justify-between gap-3 px-3 py-2"
            >
              <div className="min-w-0">
                <div className="text-ui font-medium text-foreground truncate">
                  {entry.candidate.name}
                </div>
                <div className="text-ui-sm text-muted-foreground truncate">
                  {transportDetail(entry.candidate.transport)}
                </div>
              </div>
              <Badge variant={entry.status === 'new' ? 'default' : 'outline'} className="shrink-0 font-normal">
                {entry.status === 'new' ? 'New' : 'Already added'}
              </Badge>
            </div>
          ))}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel} disabled={importing}>
            Cancel
          </Button>
          <Button onClick={onConfirm} disabled={importing || newCount === 0} aria-label="Import">
            {importing ? 'Importing…' : 'Import'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function rowSubtitle(server: McpServerDto): string {
  const provenance = server.sources
    .map((source) => source.replace(/^import:/, ''))
    .filter((source) => source !== 'nuncio');
  const parts = [transportDetail(server.transport)];
  if (provenance.length > 0) parts.push(`from ${provenance.join(', ')}`);
  if (server.engines && server.engines.length > 0) parts.push(server.engines.join('/'));
  return parts.join(' · ');
}

function transportDetail(transport: McpTransport): string {
  if (transport.type === 'stdio') {
    return `stdio · ${[transport.command, ...transport.args].join(' ')}`;
  }
  return `${transport.type} · ${transport.url}`;
}
