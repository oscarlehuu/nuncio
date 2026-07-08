import { useEffect, useMemo, useState } from 'react';
import { Loader2, Lock } from 'lucide-react';
import { toast } from 'sonner';
import { cloneForgeRepo, fetchForgeRepos, type ForgeRepoDto } from '../lib/api';
import { fetchForgeStatus, type ForgeStatusDto } from '../lib/forge-status-api';
import { CommandGroup, CommandItem } from '@/components/ui/command';
import { ProviderIcon } from './provider-icon';

/**
 * Forge repo sections for the shared ProjectPicker. A connected forge lists its
 * repos (searchable, filtered by the picker's own CommandInput query); picking one
 * clones it and hands the returned local path back exactly like a picked local path.
 * A disconnected forge shows a disabled header with its reason — never an auth
 * prompt (ADR-005). Recent / Browse / Custom in the picker are untouched.
 */
interface ProjectPickerForgesProps {
  /** The picker's live search query — repo lists filter on it client-side. */
  query: string;
  /** Hand back the cloned repo's local path (flows like any picked path). */
  onSelectPath: (path: string) => void;
  /** Only fetch when the picker is open (avoids background forge calls). */
  active: boolean;
}

export function ProjectPickerForges({ query, onSelectPath, active }: ProjectPickerForgesProps) {
  const [forges, setForges] = useState<ForgeStatusDto[]>([]);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    void fetchForgeStatus()
      .then((list) => {
        if (!cancelled) setForges(list);
      })
      .catch(() => {
        /* no forges section when the endpoint is unreachable */
      });
    return () => {
      cancelled = true;
    };
  }, [active]);

  if (forges.length === 0) return null;

  return (
    <>
      {forges.map((forge) =>
        forge.connected ? (
          <ConnectedForgeSection key={forge.id} forge={forge} query={query} onSelectPath={onSelectPath} />
        ) : (
          <DisconnectedForgeSection key={forge.id} forge={forge} />
        ),
      )}
    </>
  );
}

function ConnectedForgeSection({
  forge,
  query,
  onSelectPath,
}: {
  forge: ForgeStatusDto;
  query: string;
  onSelectPath: (path: string) => void;
}) {
  const [repos, setRepos] = useState<ForgeRepoDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [cloningId, setCloningId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void fetchForgeRepos(forge.id)
      .then((list) => {
        if (!cancelled) setRepos(list);
      })
      .catch(() => {
        /* leave empty */
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [forge.id]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return repos.slice(0, 8);
    return repos.filter((r) => r.fullName.toLowerCase().includes(q)).slice(0, 12);
  }, [repos, query]);

  const clone = async (repo: ForgeRepoDto) => {
    setCloningId(repo.id);
    try {
      const { path } = await cloneForgeRepo({
        forgeId: forge.id,
        fullName: repo.fullName,
        cloneUrl: repo.cloneUrl,
      });
      onSelectPath(path);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to clone repository');
    } finally {
      setCloningId(null);
    }
  };

  const heading = `${forge.name} repos`;
  if (!loading && filtered.length === 0) return null;

  return (
    <CommandGroup heading={heading}>
      {loading ? (
        <div className="flex items-center gap-2 px-2 py-1.5 text-ui-sm text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" />
          Loading repositories…
        </div>
      ) : (
        filtered.map((repo) => (
          <CommandItem
            key={repo.id}
            value={`${forge.id} ${repo.fullName}`}
            disabled={cloningId !== null}
            onSelect={() => void clone(repo)}
          >
            <ProviderIcon providerId={forge.id} className="size-3.5 shrink-0" />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5 text-ui-lg font-medium">
                <span className="truncate">{repo.fullName}</span>
                {repo.private && <Lock className="size-3 shrink-0 text-muted-foreground" />}
              </div>
              {repo.description && (
                <div className="truncate text-ui-sm text-muted-foreground">{repo.description}</div>
              )}
            </div>
            {cloningId === repo.id && (
              <span className="flex shrink-0 items-center gap-1 text-ui-sm text-muted-foreground">
                <Loader2 className="size-3 animate-spin" />
                Cloning…
              </span>
            )}
          </CommandItem>
        ))
      )}
    </CommandGroup>
  );
}

function DisconnectedForgeSection({ forge }: { forge: ForgeStatusDto }) {
  return (
    <CommandGroup heading={`${forge.name} repos`}>
      <div className="flex items-center gap-2 px-2 py-1.5 text-ui-sm text-muted-foreground">
        <Lock className="size-3.5 shrink-0" />
        <span>{forge.reason ?? `Connect ${forge.name} in Settings to browse repositories.`}</span>
      </div>
    </CommandGroup>
  );
}
