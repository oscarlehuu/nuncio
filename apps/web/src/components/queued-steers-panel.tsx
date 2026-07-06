import { memo } from 'react';
import { Layers } from 'lucide-react';
import type { PendingQueuedSteer } from '@/lib/transcript-build-blocks';
import { Button } from '@/components/ui/button';

interface QueuedSteersPanelProps {
  steers: PendingQueuedSteer[];
  /** Fan the queued messages out as parallel subagents. */
  onStartMultitasking: () => void | Promise<void>;
  /** A multitask request is in flight — freeze the button. */
  starting?: boolean;
}

/**
 * The pending steer queue, docked directly above the composer (Cursor-style)
 * rather than scattered inline in the transcript. Offers "Start Multitasking"
 * to run the queued messages as parallel subagents instead of waiting for them
 * to deliver sequentially. Renders nothing when the queue is empty.
 */
export const QueuedSteersPanel = memo(function QueuedSteersPanel({
  steers,
  onStartMultitasking,
  starting = false,
}: QueuedSteersPanelProps) {
  if (steers.length === 0) return null;
  return (
    <div
      className="mb-2 rounded-lg border border-border/60 bg-card/80 shadow-e1 surface-lit overflow-hidden"
      data-testid="queued-steers-panel"
    >
      <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-border/40">
        <div className="flex items-baseline gap-2 min-w-0">
          <span className="text-ui-sm font-medium text-foreground">{steers.length} Queued</span>
          <span className="text-ui-sm text-muted-foreground truncate">
            · sends when the agent is ready
          </span>
        </div>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="shrink-0 gap-1.5"
          disabled={starting}
          onClick={() => void onStartMultitasking()}
        >
          <Layers className="size-3.5" />
          Start Multitasking
        </Button>
      </div>
      <ul className="flex max-h-40 flex-col divide-y divide-border/30 overflow-y-auto">
        {steers.map((steer) => (
          <li
            key={steer.key}
            className="truncate px-3 py-2 text-ui-sm text-foreground/90"
            title={steer.text}
          >
            {steer.text}
          </li>
        ))}
      </ul>
    </div>
  );
});
