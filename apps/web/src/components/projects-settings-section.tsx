import { useCallback, useEffect, useState } from 'react';
import { FolderGit2, Pencil } from 'lucide-react';
import { toast } from 'sonner';
import {
  fetchProjectConfigs,
  upsertProjectConfig,
  type ProjectConfigDto,
} from '../lib/api';
import { EditProjectConfigDialog } from './edit-project-config-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

/**
 * Per-project config surface. Lists projects that carry overrides (default engine,
 * worktree policy, verify command, auto-steer) above the global settings, with an
 * edit affordance. A loop scoped to a project inherits these — so this is where the
 * founder tunes a repo's autopilot defaults. Empty until a project row is created.
 */
export function ProjectsSettingsSection() {
  const [configs, setConfigs] = useState<ProjectConfigDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<ProjectConfigDto | null>(null);

  const refresh = useCallback(async () => {
    try {
      setConfigs(await fetchProjectConfigs());
    } catch {
      // Section renders empty when the endpoint is unreachable (tests / offline).
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleSave = async (input: Parameters<typeof upsertProjectConfig>[0]) => {
    try {
      await upsertProjectConfig(input);
      toast.success('Project config saved');
      setEditing(null);
      await refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save');
    }
  };

  return (
    <section>
      <h2 className="mb-2 text-ui-lg font-medium text-muted-foreground">Projects</h2>
      {loading ? (
        <div className="rounded-lg border border-border bg-card px-4 py-3 text-ui text-muted-foreground">
          Loading project config…
        </div>
      ) : configs.length === 0 ? (
        <div className="rounded-lg border border-border bg-card px-4 py-3 text-ui text-muted-foreground leading-relaxed">
          No per-project overrides yet. A project inherits the global default engine, worktree policy,
          and verify command until you set one here.
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-border bg-card divide-y divide-border/60">
          {configs.map((config) => (
            <ProjectConfigRow key={config.path} config={config} onEdit={() => setEditing(config)} />
          ))}
        </div>
      )}

      <EditProjectConfigDialog
        config={editing}
        onOpenChange={(open) => !open && setEditing(null)}
        onSave={handleSave}
      />
    </section>
  );
}

function ProjectConfigRow({
  config,
  onEdit,
}: {
  config: ProjectConfigDto;
  onEdit: () => void;
}) {
  const overrides: string[] = [];
  if (config.defaultEngine) overrides.push(config.defaultEngine);
  if (config.worktreePolicy) overrides.push(`worktree: ${config.worktreePolicy}`);
  if (config.verifyCommand) overrides.push('custom verify');
  if (config.verifyAutoSteer !== 'inherit') overrides.push(`auto-steer ${config.verifyAutoSteer}`);

  return (
    <div className="flex items-center justify-between gap-3 px-4 py-3 hover:bg-muted/40 transition-colors">
      <div className="flex min-w-0 items-center gap-3">
        <FolderGit2 className="size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0">
          <div className="text-ui-lg font-medium text-foreground truncate">{config.name}</div>
          <div className="text-ui-sm text-muted-foreground truncate">{config.path}</div>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {overrides.length > 0 ? (
          <div className="hidden flex-wrap justify-end gap-1 sm:flex">
            {overrides.map((label) => (
              <Badge key={label} variant="outline" className="font-normal">
                {label}
              </Badge>
            ))}
          </div>
        ) : (
          <span className="hidden text-ui-sm text-muted-foreground sm:inline">Inherits all defaults</span>
        )}
        <Button
          variant="ghost"
          size="icon-sm"
          className="size-8"
          onClick={onEdit}
          aria-label={`Edit ${config.name} config`}
        >
          <Pencil className="size-3.5" />
        </Button>
      </div>
    </div>
  );
}
