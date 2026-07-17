import { useCallback, useEffect, useRef, useState } from 'react';
import { Check } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import {
  approveDispatcherProposal,
  ackAttentionItem,
  actChip,
  dismissChip,
  fetchAttention,
  resolveAttentionItem,
  type AttentionItemDto,
} from '../lib/api';
import type { OpenTarget } from '../lib/attention-kind';
import { cn } from '@/lib/utils';
import { AttentionRow } from './attention-row';

interface AttentionQueueProps {
  compactEmpty?: boolean;
}

/**
 * Ranked attention queue: rows stay server-ordered, because ranking belongs to
 * the collector. Shared by Home and the legacy Inbox shell.
 */
export function AttentionQueue({ compactEmpty = false }: AttentionQueueProps) {
  const navigate = useNavigate();
  const [items, setItems] = useState<AttentionItemDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const errorShown = useRef(false);
  const inFlight = useRef(new Set<string>());

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

  const act = async (
    id: string,
    action: (id: string) => Promise<unknown>,
    afterSuccess?: (result: unknown) => void,
  ) => {
    if (inFlight.current.has(id)) return;
    inFlight.current.add(id);
    setBusyId(id);
    try {
      const result = await action(id);
      afterSuccess?.(result);
      await refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Action failed');
    } finally {
      inFlight.current.delete(id);
      setBusyId(null);
    }
  };

  if (loading) {
    return (
      <ul className="flex flex-col gap-3" aria-hidden>
        {[0, 1, 2].map((i) => (
          <li
            key={i}
            className="h-[76px] rounded-xl border border-border bg-card shadow-e1 animate-pulse"
          />
        ))}
      </ul>
    );
  }

  if (items.length === 0) return <EmptyState compact={compactEmpty} />;

  return (
    <ul className="flex flex-col gap-3">
      {items.map((item) => (
        <AttentionRow
          key={item.id}
          item={item}
          busy={busyId === item.id}
          onOpen={handleOpen}
          onApprove={(id, proposalCount) =>
            void act(id, approveDispatcherProposal, (result) => {
              const taskIds = (result as { taskIds?: unknown }).taskIds;
              const count = Array.isArray(taskIds) ? taskIds.length : proposalCount;
              toast.success(`${count} task${count === 1 ? '' : 's'} queued`);
            })
          }
          onAck={(id) => void act(id, ackAttentionItem)}
          onResolve={(id) =>
            item.kind === 'spawn-task'
              ? void act(id, (chipId) => dismissChip(chipId))
              : void act(id, resolveAttentionItem)
          }
          onCreate={(id) =>
            void act(id, actChip, (result) => {
              const childId = (result as { session?: { id?: unknown } }).session?.id;
              if (typeof childId === 'string') navigate(`/session/${childId}`);
            })
          }
        />
      ))}
    </ul>
  );
}

/** The empty queue is the PRODUCT GOAL; keep it calm, not blank. */
function EmptyState({ compact }: { compact: boolean }) {
  return (
    <div
      className={cn(
        'mx-auto flex max-w-[380px] flex-col items-center text-center',
        compact ? 'gap-2 py-3' : 'gap-4 py-20',
      )}
    >
      {!compact && (
        <span className="grid size-12 place-items-center rounded-2xl bg-muted text-muted-foreground shadow-e0">
          <Check className="size-6" />
        </span>
      )}
      <div className="space-y-1.5">
        <h2 className="text-ui-lg font-semibold text-foreground">Nothing needs you</h2>
        <p
          className={cn('text-ui text-muted-foreground leading-relaxed', compact && 'text-ui-sm')}
        >
          Every agent is running clean - no approvals, stuck verifies, or paused loops waiting on you.
        </p>
      </div>
    </div>
  );
}
