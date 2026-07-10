import { Link } from 'react-router-dom';
import type { CrewRunDto } from '@nuncio/core/crew-api';
import { cn } from '@/lib/utils';

export function CrewRunHistory({
  taskId,
  runs,
  selectedRunId,
}: {
  taskId: string;
  runs: CrewRunDto[];
  selectedRunId: string;
}) {
  if (runs.length < 2) return null;
  const numbered = runs.map((run, index) => ({ run, number: index + 1 })).reverse();
  return (
    <nav aria-label="Crew run history" className="min-w-0">
      <h2 className="mb-2 text-ui-sm font-semibold text-muted-foreground">Run history</h2>
      <ul className="flex min-w-0 gap-2 overflow-x-auto pb-1">
        {numbered.map(({ run, number }) => {
          const selected = run.id === selectedRunId;
          const state = title(run.outcome ?? run.status);
          return (
            <li key={run.id} className="shrink-0">
              <Link
                to={`/crew/${encodeURIComponent(taskId)}?run=${encodeURIComponent(run.id)}`}
                aria-current={selected ? 'page' : undefined}
                className={cn(
                  'flex min-h-11 min-w-32 flex-col justify-center rounded-lg border px-3 py-1.5 text-ui-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  selected ? 'border-primary bg-secondary text-foreground' : 'border-border text-muted-foreground hover:bg-muted',
                )}
              >
                <span className="font-medium">Run {number}</span>
                <span>{title(run.phase)} · {state}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

function title(value: string): string {
  return value.toLowerCase().replaceAll('_', ' ').replace(/^\w/, (letter) => letter.toUpperCase());
}
