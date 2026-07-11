import { Check, Circle, LoaderCircle } from 'lucide-react';
import type { CrewRunProjection } from '@nuncio/core/crew-run-projection';
import { cn } from '@/lib/utils';

const label = (phase: string) => phase[0] + phase.slice(1).toLowerCase();

export function CrewRunProgress({ steps }: { steps: CrewRunProjection['steps'] }) {
  return (
    <ol aria-label="Crew run progress" className="grid min-w-0 grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
      {steps.map((step) => {
        const Icon = step.state === 'complete' ? Check : step.state === 'current' ? LoaderCircle : Circle;
        return (
          <li key={step.phase} aria-current={step.state === 'current' ? 'step' : undefined} className={cn('flex min-w-0 items-center gap-2 rounded-lg border px-3 py-2 text-ui-sm', step.state === 'current' ? 'border-primary/50 bg-primary/5 text-foreground' : 'border-border text-muted-foreground')}>
            <Icon className={cn('size-4 shrink-0', step.state === 'current' && 'animate-spin')} />
            <span className="truncate" title={label(step.phase)}>{label(step.phase)}</span>
          </li>
        );
      })}
    </ol>
  );
}
