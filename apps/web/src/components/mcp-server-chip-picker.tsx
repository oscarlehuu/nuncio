import { useCallback, useEffect, useState } from 'react';
import { fetchMcpServers, type McpServerDto } from '../lib/mcp-servers-api';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

interface McpServerChipPickerProps {
  projectPath?: string;
  selectedIds: string[];
  onChange: (ids: string[]) => void;
  className?: string;
}

/** Compact multi-select chips for per-session MCP server overrides on the home composer. */
export function McpServerChipPicker({
  projectPath,
  selectedIds,
  onChange,
  className,
}: McpServerChipPickerProps) {
  const [servers, setServers] = useState<McpServerDto[]>([]);

  const refresh = useCallback(async () => {
    try {
      const all = await fetchMcpServers();
      const enabled = all.filter((server) => {
        if (!server.enabled) return false;
        if (server.projectPath === null) return true;
        if (!projectPath) return false;
        return server.projectPath.replace(/\/+$/, '') === projectPath.replace(/\/+$/, '');
      });
      setServers(enabled);
    } catch {
      setServers([]);
    }
  }, [projectPath]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (servers.length === 0) return null;

  const toggle = (id: string) => {
    const next = selectedIds.includes(id)
      ? selectedIds.filter((entry) => entry !== id)
      : [...selectedIds, id];
    onChange(next);
  };

  return (
    <div className={cn('flex flex-wrap items-center gap-1.5', className)}>
      <span className="text-ui-sm text-muted-foreground">MCP</span>
      {servers.map((server) => {
        const active = selectedIds.includes(server.id);
        return (
          <button
            key={server.id}
            type="button"
            onClick={() => toggle(server.id)}
            className="rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-pressed={active}
            aria-label={`${active ? 'Remove' : 'Add'} MCP server ${server.name}`}
          >
            <Badge variant={active ? 'default' : 'outline'} className="font-normal cursor-pointer">
              {server.name}
            </Badge>
          </button>
        );
      })}
    </div>
  );
}
