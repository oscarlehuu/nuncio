import { Users, User } from 'lucide-react';
import { cn } from '@/lib/utils';

export type ExecutionMode = 'solo' | 'crew';

export function ExecutionModePicker({
  value,
  onChange,
}: {
  value: ExecutionMode;
  onChange: (mode: ExecutionMode) => void;
}) {
  return (
    <div role="radiogroup" aria-label="Execution mode" className="flex shrink-0 rounded-lg border border-border bg-muted/20 p-0.5">
      {([
        ['solo', 'Solo', User],
        ['crew', 'Crew', Users],
      ] as const).map(([mode, label, Icon]) => (
        <button
          key={mode}
          type="button"
          role="radio"
          aria-checked={value === mode}
          onClick={() => onChange(mode)}
          className={cn(
            'flex min-h-11 items-center gap-1.5 rounded-md px-3 text-ui font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            value === mode ? 'bg-background text-foreground shadow-e0' : 'text-muted-foreground',
          )}
        >
          <Icon className="size-3.5" />
          {label}
        </button>
      ))}
    </div>
  );
}
