import { useEffect, useRef, useState } from 'react';
import { ChevronDown, GitBranch } from 'lucide-react';
import { fetchBranches, type Branch } from '../lib/projects';
import { isNuncioSessionBranch } from '../lib/project-preference';
import { Button } from '@/components/ui/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';

interface BranchPickerProps {
  projectPath?: string;
  value?: string;
  onChange: (branch: string) => void;
}

export function BranchPicker({ projectPath, value, onChange }: BranchPickerProps) {
  const [branches, setBranches] = useState<Branch[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const disabled = !projectPath;
  const valueRef = useRef(value);
  valueRef.current = value;

  useEffect(() => {
    if (!projectPath) {
      setBranches([]);
      setLoadError(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setLoadError(false);
    void fetchBranches(projectPath)
      .then((items) => {
        if (cancelled) return;
        const baseBranches = items.filter((branch) => !isNuncioSessionBranch(branch.name));
        setBranches(baseBranches);
        if (
          !valueRef.current ||
          isNuncioSessionBranch(valueRef.current) ||
          !baseBranches.some((branch) => branch.name === valueRef.current)
        ) {
          const preferred =
            baseBranches.find((branch) => branch.isCurrent) ??
            baseBranches.find((branch) => branch.isDefault) ??
            baseBranches[0];
          if (preferred) onChange(preferred.name);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setBranches([]);
          setLoadError(true);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [projectPath, onChange]);

  const safeValue = isNuncioSessionBranch(value) ? undefined : value;
  const selected = branches.find((branch) => branch.name === safeValue);
  const label = disabled
    ? 'Base branch'
    : loadError
      ? 'Branch unavailable'
      : selected?.name ?? safeValue ?? 'Base branch';

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          className="composer-picker-trigger h-8 gap-1.5 px-2.5 max-w-[160px]"
          disabled={disabled}
        >
          <GitBranch className="size-3.5 shrink-0 text-muted-foreground" />
          <span className={`truncate text-[13px] ${safeValue ? 'font-medium' : 'text-muted-foreground'}`}>
            {label}
          </span>
          <ChevronDown data-icon="inline-end" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[280px] p-0" align="start">
        <Command>
          <CommandInput placeholder="Search base branches…" />
          <CommandList>
            {loading ? (
              <div className="py-6 text-center text-sm text-muted-foreground">Loading branches…</div>
            ) : (
              <>
                <CommandEmpty>No branch found.</CommandEmpty>
                <CommandGroup heading="Base branches">
                  {branches.map((branch) => (
                    <CommandItem
                      key={branch.name}
                      value={branch.name}
                      onSelect={() => {
                        onChange(branch.name);
                        setOpen(false);
                      }}
                      data-checked={branch.name === safeValue ? 'true' : undefined}
                    >
                      <span className="truncate">{branch.name}</span>
                      {branch.isDefault && (
                        <span className="ml-auto text-[10px] text-muted-foreground">default</span>
                      )}
                    </CommandItem>
                  ))}
                </CommandGroup>
              </>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
