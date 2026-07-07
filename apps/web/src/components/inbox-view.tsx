import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Check } from 'lucide-react';
import { toast } from 'sonner';
import {
  ackAttentionItem,
  fetchAttention,
  resolveAttentionItem,
  type AttentionItemDto,
} from '../lib/api';
import { AttentionRow } from './attention-row';
import type { OpenTarget } from '../lib/attention-kind';
import { Button } from '@/components/ui/button';

interface InboxViewProps {
  onBack: () => void;
}

/**
 * The Inbox — ONE ranked queue of everything needing the founder (rung 3). The
 * server ranks by severity → project → age, so items render in the order received
 * (no client re-sort; acked items stay muted in place). Polls while mounted so a
 * newly-raised item or a cleared condition shows without a manual refresh.
 */
export function InboxView({ onBack }: InboxViewProps) {
  const navigate = useNavigate();
  const [items, setItems] = useState<AttentionItemDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const errorShown = useRef(false);

  const refresh = useCallback(async () => {
    try {
      const { items: next } = await fetchAttention();
      setItems(next);
      errorShown.current = false;
    } catch {
      if (!errorShown.current) {
        toast.error('Failed to load the inbox');
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

  const handleOpen = (target: OpenTarget) => {
    if ('href' in target) {
      window.open(target.href, '_blank', 'noopener,noreferrer');
    } else {
      navigate(target.to);
    }
  };

  const act = async (id: string, action: (id: string) => Promise<unknown>) => {
    setBusyId(id);
    try {
      await action(id);
      await refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Action failed');
    } finally {
      setBusyId(null);
    }
  };

  const unacked = items.filter((i) => i.acknowledgedAt === null).length;

  return (
    <section className="flex-1 flex flex-col min-h-0 overflow-hidden bg-background">
      <header className="flex items-center gap-2 px-4 py-3 border-b border-border sticky top-0 bg-background/80 backdrop-blur z-10">
        <Button variant="ghost" size="icon" onClick={onBack} aria-label="Back">
          <ArrowLeft className="size-4" />
        </Button>
        <h1 className="text-lg font-semibold tracking-tight">Inbox</h1>
        {!loading && unacked > 0 && (
          <span className="ml-1 rounded-full bg-warning/15 px-2 py-0.5 text-ui-sm font-medium text-warning tabular-nums">
            {unacked}
          </span>
        )}
      </header>

      <div className="flex-1 overflow-y-auto px-4 py-6">
        <div className="mx-auto w-full max-w-[720px]">
          {loading ? (
            <ul className="flex flex-col gap-3" aria-hidden>
              {[0, 1, 2].map((i) => (
                <li key={i} className="h-[76px] rounded-xl border border-border bg-card shadow-e1 animate-pulse" />
              ))}
            </ul>
          ) : items.length === 0 ? (
            <EmptyState />
          ) : (
            <ul className="flex flex-col gap-3">
              {items.map((item) => (
                <AttentionRow
                  key={item.id}
                  item={item}
                  busy={busyId === item.id}
                  onOpen={handleOpen}
                  onAck={(id) => void act(id, ackAttentionItem)}
                  onResolve={(id) => void act(id, resolveAttentionItem)}
                />
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}

/** The empty inbox is the PRODUCT GOAL — make it read calm and earned, not blank. */
function EmptyState() {
  return (
    <div className="mx-auto flex max-w-[380px] flex-col items-center gap-4 py-20 text-center">
      <span className="grid size-12 place-items-center rounded-2xl bg-success/10 text-success shadow-e0">
        <Check className="size-6" />
      </span>
      <div className="space-y-1.5">
        <h2 className="text-ui-lg font-semibold text-foreground">Nothing needs you</h2>
        <p className="text-ui text-muted-foreground leading-relaxed">
          Every agent is running clean — no approvals, stuck verifies, or paused loops waiting on you.
        </p>
      </div>
    </div>
  );
}
