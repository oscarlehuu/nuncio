import { Ban, Check, Circle, LoaderCircle, X } from 'lucide-react';
import type { CrewRunProjection } from '@nuncio/core/crew-run-projection';
import { cn } from '@/lib/utils';

const label = (phase: string) => phase[0] + phase.slice(1).toLowerCase();
const STATE_TEXT = { complete: 'completed', current: 'in progress', upcoming: 'pending', unknown: 'completion unknown', failed: 'failed', cancelled: 'cancelled' } as const;

export function CrewRunProgress({ steps }: { steps: CrewRunProjection['steps'] }) {
  return (
    <ol aria-label="Crew run progress" className="grid min-w-0 grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
      {steps.map((step, index) => {
        const prev = index > 0 ? steps[index - 1] : null;
        const Icon = step.state === 'complete' ? Check
          : step.state === 'current' ? LoaderCircle
            : step.state === 'failed' ? X
              : step.state === 'cancelled' ? Ban : Circle;
        return (
          <li
            key={step.phase}
            data-state={step.state}
            aria-current={step.state === 'current' ? 'step' : undefined}
            className={cn(
              'relative flex min-w-0 items-center gap-2 rounded-lg border px-3 py-2 text-ui-sm transition-colors',
              // Connector into this node, drawn only on the single-row layout so the
              // six phases read as one pipeline; completed segments carry success.
              index > 0 && "lg:before:absolute lg:before:right-full lg:before:top-1/2 lg:before:h-px lg:before:w-2 lg:before:-translate-y-1/2 lg:before:content-['']",
              prev?.state === 'complete' ? 'lg:before:bg-success/40' : 'lg:before:bg-border',
              step.state === 'complete' && 'border-success/40 text-foreground',
              step.state === 'current' && 'border-primary/60 bg-primary/5 text-foreground',
              step.state === 'upcoming' && 'border-border/60 text-muted-foreground',
              step.state === 'unknown' && 'border-border bg-muted/20 text-muted-foreground',
              step.state === 'failed' && 'border-destructive/50 bg-destructive/5 text-destructive',
              step.state === 'cancelled' && 'border-border bg-muted/40 text-muted-foreground',
            )}
          >
            <Icon
              className={cn(
                'size-4 shrink-0',
                step.state === 'complete' && 'text-success',
                step.state === 'current' && 'animate-spin text-primary',
                step.state === 'upcoming' && 'text-muted-foreground/70',
                step.state === 'unknown' && 'text-muted-foreground/70',
                step.state === 'failed' && 'text-destructive',
                step.state === 'cancelled' && 'text-muted-foreground',
              )}
            />
            <span className="truncate" title={label(step.phase)}>{label(step.phase)}</span>
            <span className="sr-only">{STATE_TEXT[step.state]}</span>
          </li>
        );
      })}
    </ol>
  );
}
