import { Users } from 'lucide-react';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';

export type ExecutionMode = 'solo' | 'crew';

export function ExecutionModePicker({
  value,
  onChange,
}: {
  value: ExecutionMode;
  onChange: (mode: ExecutionMode) => void;
}) {
  const enabled = value === 'crew';
  return (
    <div
      className={cn(
        'inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-1.5 text-ui font-medium transition-colors',
        enabled ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
      )}
    >
      <Users aria-hidden className="size-3.5" />
      <label htmlFor="crew-mode-toggle" className="cursor-pointer">Crew</label>
      <Switch
        id="crew-mode-toggle"
        aria-label="Crew"
        checked={enabled}
        onCheckedChange={(checked) => onChange(checked ? 'crew' : 'solo')}
      />
    </div>
  );
}
