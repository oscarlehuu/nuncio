import { useCallback, useEffect, useState } from 'react';
import {
  ArrowLeft,
  ArrowUpRight,
  Bell,
  CheckCircle2,
  Circle,
  GitPullRequestArrow,
  ListChecks,
  PauseCircle,
  PlayCircle,
  Repeat,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { fetchTimeline, relativeTime, type TimelineEntryDto } from '../lib/api';
import { projectDisplayName } from '../lib/projects';
import { timelineTargetFor } from '../lib/timeline-links';
import { Button } from '@/components/ui/button';

const PAGE_SIZE = 40;

export function TimelineView({ onBack }: { onBack: () => void }) {
  const navigate = useNavigate();
  const [entries, setEntries] = useState<TimelineEntryDto[]>([]);
  const [nextBefore, setNextBefore] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);

  const load = useCallback(async (before?: number) => {
    if (before === undefined) setLoading(true);
    else setLoadingMore(true);
    try {
      const dto = await fetchTimeline({ limit: PAGE_SIZE, ...(before !== undefined ? { before } : {}) });
      setEntries((prev) => (before === undefined ? dto.entries : [...prev, ...dto.entries]));
      setNextBefore(dto.nextBefore);
    } catch {
      toast.error('Failed to load timeline');
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const openEntry = (entry: TimelineEntryDto) => {
    const target = timelineTargetFor(entry);
    if (!target) return;
    if ('href' in target) window.open(target.href, '_blank', 'noopener,noreferrer');
    else navigate(target.to);
  };

  return (
    <section className="flex-1 flex flex-col min-h-0 overflow-hidden bg-background">
      <header className="flex items-center gap-2 px-4 py-3 border-b border-border sticky top-0 bg-background/80 backdrop-blur z-10">
        <Button variant="ghost" size="icon" onClick={onBack} aria-label="Back">
          <ArrowLeft className="size-4" />
        </Button>
        <h1 className="text-lg font-semibold tracking-tight">Timeline</h1>
      </header>

      <div className="flex-1 overflow-y-auto px-4 py-6">
        <div className="mx-auto w-full max-w-[640px]">
          {loading ? (
            <div className="space-y-3" aria-hidden>
              {[0, 1, 2].map((i) => (
                <div key={i} className="h-16 rounded-xl bg-muted/40 animate-pulse" />
              ))}
            </div>
          ) : entries.length === 0 ? (
            <div className="py-20 text-center text-ui text-muted-foreground">No timeline events yet</div>
          ) : (
            <>
              <ul className="space-y-2">
                {entries.map((entry) => (
                  <TimelineRow key={entry.id} entry={entry} onOpen={() => openEntry(entry)} />
                ))}
              </ul>
              {nextBefore !== null && (
                <Button
                  variant="outline"
                  className="mt-4 w-full"
                  disabled={loadingMore}
                  onClick={() => void load(nextBefore)}
                >
                  {loadingMore ? 'Loading...' : 'Load more'}
                </Button>
              )}
            </>
          )}
        </div>
      </div>
    </section>
  );
}

function TimelineRow({ entry, onOpen }: { entry: TimelineEntryDto; onOpen: () => void }) {
  const Icon = iconForKind(entry.kind);
  const target = timelineTargetFor(entry);
  return (
    <li className="surface-lit flex items-center gap-3 rounded-xl border border-border bg-card px-3 py-3 shadow-e1">
      <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-muted/50 text-muted-foreground" aria-label={entry.kind}>
        <Icon className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-ui font-medium text-foreground">{entry.title}</p>
        <p className="mt-0.5 truncate text-ui-sm text-muted-foreground">
          {[projectDisplayName(entry.projectPath), entry.provider, relativeTime(entry.ts)].filter(Boolean).join(' - ')}
        </p>
      </div>
      {target && (
        <Button variant="ghost" size="sm" className="h-8 px-2.5" onClick={onOpen} aria-label={`Open ${entry.title}`}>
          <ArrowUpRight className="size-3.5" />
        </Button>
      )}
    </li>
  );
}

function iconForKind(kind: string): LucideIcon {
  switch (kind) {
    case 'session-started':
      return PlayCircle;
    case 'session-completed':
    case 'task-done':
      return CheckCircle2;
    case 'session-needs-you':
    case 'task-failed':
    case 'breaker-tripped':
      return TriangleAlert;
    case 'breaker-resumed':
      return PauseCircle;
    case 'loop-run-settled':
      return Repeat;
    case 'attention-raised':
    case 'attention-resolved':
      return Bell;
    case 'pr-opened-detected':
      return GitPullRequestArrow;
    case 'digest-sent':
      return ListChecks;
    default:
      return Circle;
  }
}
