import { ChevronDown, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '../lib/utils';
import type { SessionMode } from '../lib/api';
import { SESSION_MODE_META } from '../lib/session-modes';

/** A compact mode chip — reused in the composer trigger and the session header/tile. */
export function SessionModeChip({
  mode,
  className,
}: {
  mode: SessionMode;
  className?: string;
}) {
  const meta = SESSION_MODE_META[mode];
  const Icon = meta.icon;
  return (
    <span
      data-testid="session-mode-chip"
      data-mode={mode}
      className={cn(
        'inline-flex items-center gap-1 rounded-md border border-border/70 bg-muted/40 px-1.5 py-0.5 text-ui font-medium text-foreground',
        className,
      )}
    >
      <Icon aria-hidden className="size-3" />
      {meta.label}
    </span>
  );
}

const NORMAL_VALUE = 'normal';

interface SessionModePickerProps {
  /** Active mode, or null for the normal agent. */
  value: SessionMode | null;
  onChange: (value: SessionMode | null) => void;
  /** Modes the selected provider advertises via `capabilities.modes`. */
  supportedModes: SessionMode[];
  disabled?: boolean;
  className?: string;
}

/**
 * Composer mode selector. Renders nothing when the provider supports no modes
 * (capability-gated). The trigger doubles as the selected-mode chip.
 */
export function SessionModePicker({
  value,
  onChange,
  supportedModes,
  disabled,
  className,
}: SessionModePickerProps) {
  const modes = supportedModes.filter((mode): mode is SessionMode => mode in SESSION_MODE_META);
  if (modes.length === 0) return null;

  const activeMeta = value ? SESSION_MODE_META[value] : null;
  const TriggerIcon = activeMeta?.icon ?? Sparkles;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled}
          aria-label={`Session mode: ${activeMeta?.label ?? 'Agent'}`}
          className={cn('composer-picker-trigger h-8 gap-1.5 px-2.5', className)}
        >
          <TriggerIcon className="size-3.5" />
          <span className="text-ui-lg">{activeMeta?.label ?? 'Agent'}</span>
          <ChevronDown className="size-3 opacity-70" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-[300px]">
        <DropdownMenuLabel>Mode</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={value ?? NORMAL_VALUE}
          onValueChange={(next) => onChange(next === NORMAL_VALUE ? null : (next as SessionMode))}
        >
          <DropdownMenuRadioItem value={NORMAL_VALUE} className="items-start gap-2 py-2">
            <Sparkles className="mt-0.5 size-4 text-muted-foreground" />
            <span className="flex min-w-0 flex-col gap-0.5">
              <span>Agent</span>
              <span className="text-xs leading-snug text-muted-foreground">
                The standard coding agent
              </span>
            </span>
          </DropdownMenuRadioItem>
          {modes.map((mode) => {
            const meta = SESSION_MODE_META[mode];
            const ModeIcon = meta.icon;
            return (
              <DropdownMenuRadioItem key={mode} value={mode} className="items-start gap-2 py-2">
                <ModeIcon className="mt-0.5 size-4 text-muted-foreground" />
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span>{meta.label}</span>
                  <span className="text-xs leading-snug text-muted-foreground">
                    {meta.description}
                  </span>
                </span>
              </DropdownMenuRadioItem>
            );
          })}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
