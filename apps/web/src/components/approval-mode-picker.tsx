import { ChevronDown, Hand, ShieldCheck } from 'lucide-react';
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

export type ApprovalMode = 'approval-required' | 'full-access';

interface ApprovalModePickerProps {
  value: ApprovalMode;
  onChange: (value: ApprovalMode) => void | Promise<void>;
  disabled?: boolean;
  surface?: 'toolbar' | 'embedded';
  className?: string;
}

const MODES: Array<{
  value: ApprovalMode;
  label: string;
  description: string;
  icon: typeof Hand;
}> = [
  {
    value: 'approval-required',
    label: 'Ask for approval',
    description: 'Ask before external file edits and network access',
    icon: Hand,
  },
  {
    value: 'full-access',
    label: 'Full access',
    description: 'Run unrestricted on this self-hosted machine',
    icon: ShieldCheck,
  },
];

export function ApprovalModePicker({
  value,
  onChange,
  disabled,
  surface = 'toolbar',
  className,
}: ApprovalModePickerProps) {
  const selected = MODES.find((mode) => mode.value === value) ?? MODES[1];
  const Icon = selected.icon;
  const embedded = surface === 'embedded';
  const fullAccessTone =
    embedded && selected.value === 'full-access'
      ? '!text-destructive hover:!text-destructive aria-expanded:!text-destructive'
      : undefined;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant={embedded ? 'ghost' : 'outline'}
          size="sm"
          disabled={disabled}
          aria-label={`Approval mode: ${selected.label}`}
          className={cn(
            embedded
              ? 'h-8 gap-1.5 border-transparent bg-transparent px-2.5 shadow-none hover:bg-muted/60 aria-expanded:bg-muted dark:hover:bg-muted/70'
              : 'composer-picker-trigger h-8 gap-1.5 px-2.5',
            fullAccessTone,
            className,
          )}
        >
          <Icon className="size-3.5" />
          <span>{selected.label}</span>
          <ChevronDown className="size-3.5 opacity-70" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-[300px]">
        <DropdownMenuLabel>Approval</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={value}
          onValueChange={(next) => void onChange(next as ApprovalMode)}
        >
          {MODES.map((mode) => {
            const ModeIcon = mode.icon;
            return (
              <DropdownMenuRadioItem
                key={mode.value}
                value={mode.value}
                className="items-start gap-2 py-2"
              >
                <ModeIcon className="mt-0.5 size-4 text-muted-foreground" />
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span>{mode.label}</span>
                  <span className="text-xs leading-snug text-muted-foreground">
                    {mode.description}
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
