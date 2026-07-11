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
    <div
      role="radiogroup"
      aria-label="Execution mode"
      data-density="compact"
      className="flex shrink-0 items-center rounded-md bg-muted/45 p-0.5"
    >
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
            'flex h-9 items-center gap-1.5 rounded-[5px] px-2.5 text-ui font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            value === mode
              ? 'bg-background text-foreground shadow-e0'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          <Icon className="size-3.5" />
          {label}
        </button>
      ))}
    </div>
  );
}
