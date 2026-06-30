import { ChevronDown, GitBranchPlus, Laptop } from 'lucide-react';
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

export type WorkspaceMode = 'local' | 'worktree';

interface WorkspaceModePickerProps {
  value: WorkspaceMode;
  onChange: (value: WorkspaceMode) => void;
  disabled?: boolean;
  className?: string;
}

const MODES: Array<{
  value: WorkspaceMode;
  label: string;
  description: string;
  icon: typeof Laptop;
}> = [
  {
    value: 'local',
    label: 'Work locally',
    description: 'Run in the selected repo checkout',
    icon: Laptop,
  },
  {
    value: 'worktree',
    label: 'New worktree',
    description: 'Fork from the selected branch',
    icon: GitBranchPlus,
  },
];

export function WorkspaceModePicker({
  value,
  onChange,
  disabled,
  className,
}: WorkspaceModePickerProps) {
  const selected = MODES.find((mode) => mode.value === value) ?? MODES[0];
  const Icon = selected.icon;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled}
          aria-label={`Workspace mode: ${selected.label}`}
          className={cn('composer-picker-trigger h-8 gap-1.5 px-2.5', className)}
        >
          <Icon className="size-3.5" />
          <span>{selected.label}</span>
          <ChevronDown className="size-3.5 opacity-70" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-[300px]">
        <DropdownMenuLabel>Workspace</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={value}
          onValueChange={(next) => onChange(next as WorkspaceMode)}
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
