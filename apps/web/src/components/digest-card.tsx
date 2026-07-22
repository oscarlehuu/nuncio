import { useEffect, useState } from 'react';
import { ChevronRight, Moon, Sunrise } from 'lucide-react';
import { fetchDigest, relativeTime, type DigestRunDto } from '../lib/api';
import { cn } from '@/lib/utils';

/**
 * A slim "Today's digest" entry point at the top of the Inbox — the digest shares
 * the Inbox's coffee-moment rhythm (what happened + what's open), so it lives here
 * rather than adding a fifth sidebar entry. Renders nothing until a digest exists.
 */
export function DigestCard({ onOpen }: { onOpen: () => void }) {
  const [dto, setDto] = useState<DigestRunDto | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetchDigest('latest')
      .then((d) => {
        if (!cancelled) setDto(d);
      })
      .catch(() => {
        /* no card when the digest can't load */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!dto) return null;

  const evening = dto.variant === 'evening';
  const Icon = evening ? Moon : Sunrise;
  const title = evening ? 'Evening pre-flight' : 'Morning digest';

  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`Read the ${title}`}
      className="group mb-4 flex w-full items-center gap-3 rounded-xl border border-border bg-card px-4 py-3 text-left transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.995]"
    >
      <span className={cn('grid size-9 shrink-0 place-items-center rounded-lg bg-muted/60 text-muted-foreground')}>
        <Icon className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-ui-lg font-medium text-foreground">Today's digest</div>
        <div className="text-ui-sm text-muted-foreground">
          {title} · {relativeTime(dto.sentAt)}
        </div>
      </div>
      <ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
    </button>
  );
}
