import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Ship } from 'lucide-react';
import { toast } from 'sonner';
import { fetchFleet, type FleetRow as FleetRowDto } from '../lib/api';
import { AttentionQueue } from './attention-queue';
import { DigestCard } from './digest-card';
import { FleetRow } from './fleet-row';
import { openTargetFor } from '../lib/attention-kind';
import { Button } from '@/components/ui/button';

interface FleetViewProps {
  /** Start a new agent (the composer moved off '/'). */
  onNew: () => void;
}

/**
 * Home cockpit. Attention items and fleet rows share the page but stay at
 * different altitudes: queue item first, project rollup second.
 */
export function FleetView({ onNew }: FleetViewProps) {
  const navigate = useNavigate();
  const [rows, setRows] = useState<FleetRowDto[]>([]);
  const [loading, setLoading] = useState(true);
  const errorShown = useRef(false);

  const refresh = useCallback(async () => {
    try {
      setRows(await fetchFleet());
      errorShown.current = false;
    } catch {
      if (!errorShown.current) {
        toast.error('Failed to load the fleet');
        errorShown.current = true;
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 8000);
    return () => clearInterval(timer);
  }, [refresh]);

  const openProject = (row: FleetRowDto) =>
    navigate(`/grid?project=${encodeURIComponent(row.path)}`, { replace: false });

  const openTopItem = (row: FleetRowDto) => {
    if (!row.topItem) return;
    const target = openTargetFor(row.topItem);
    if (!target) {
      openProject(row);
    } else if ('href' in target) {
      window.open(target.href, '_blank', 'noopener,noreferrer');
    } else {
      navigate(target.to);
    }
  };

  return (
    <section className="flex-1 flex flex-col min-h-0 overflow-hidden bg-background">
      <header className="flex items-center gap-2 px-4 py-3 border-b border-border sticky top-0 bg-background/80 backdrop-blur z-10">
        <h1 className="text-lg font-semibold tracking-tight">Home</h1>
        <div className="ml-auto">
          <Button size="sm" className="gap-1.5" onClick={onNew}>
            <Plus className="size-4" />
            <span>New agent</span>
            <kbd
              aria-hidden
              className="hidden rounded border border-primary-foreground/30 px-1 font-mono text-[0.65rem] sm:inline"
            >
              ⌘N
            </kbd>
          </Button>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto px-4 py-6">
        <div className="mx-auto flex w-full max-w-[720px] flex-col gap-6">
          <DigestCard onOpen={() => navigate('/digest')} />
          <AttentionQueue compactEmpty />
          <section aria-labelledby="fleet-section-title" className="flex flex-col gap-3">
            <h2
              id="fleet-section-title"
              className="text-ui-sm font-medium uppercase tracking-[0.08em] text-muted-foreground"
            >
              Fleet
            </h2>
            {loading ? (
              <ul className="flex flex-col gap-3" aria-hidden>
                {[0, 1, 2].map((i) => (
                  <li
                    key={i}
                    className="h-[84px] rounded-xl border border-border bg-card shadow-e1 animate-pulse"
                  />
                ))}
              </ul>
            ) : rows.length === 0 ? (
              <EmptyState onNew={onNew} />
            ) : (
              <ul className="flex flex-col gap-3">
                {rows.map((row) => (
                  <FleetRow
                    key={row.path}
                    row={row}
                    onOpen={() => openProject(row)}
                    onOpenTopItem={() => openTopItem(row)}
                  />
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
    </section>
  );
}

/** No projects yet — a warm start, pointing at the first agent. */
function EmptyState({ onNew }: { onNew: () => void }) {
  return (
    <div className="mx-auto flex max-w-[420px] flex-col items-center gap-4 rounded-2xl border border-dashed border-border bg-card/40 px-8 py-16 text-center">
      <span className="grid size-12 place-items-center rounded-2xl bg-muted/60 text-muted-foreground shadow-e0">
        <Ship className="size-6" />
      </span>
      <div className="space-y-1.5">
        <h2 className="text-ui-lg font-semibold text-foreground">Your fleet is empty</h2>
        <p className="text-ui text-muted-foreground leading-relaxed">
          Start an agent on a project and it will show up here — one row per repo, coloured by whether
          anything needs you.
        </p>
      </div>
      <Button className="gap-1.5" onClick={onNew}>
        <Plus className="size-4" />
        Start your first agent
      </Button>
    </div>
  );
}
