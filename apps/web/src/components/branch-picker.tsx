import { useEffect, useRef, useState } from 'react';
import { ChevronDown, GitBranch } from 'lucide-react';
import { fetchBranches, type Branch } from '../lib/projects';
import { isNuncioSessionBranch } from '../lib/project-preference';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
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
  /** 'boxed' = composer toolbar chip; 'text' = borderless Cursor context label. */
  variant?: 'boxed' | 'text';
  /** Origin-absolute API base when browsing a project on another hub machine. */
  apiBase?: string;
}

export function BranchPicker({
  projectPath,
  value,
  onChange,
  variant = 'boxed',
  apiBase = '',
}: BranchPickerProps) {
  const asText = variant === 'text';
  const [branches, setBranches] = useState<Branch[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const disabled = !projectPath;
  const valueRef = useRef(value);
  valueRef.current = value;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const apiBaseRef = useRef(apiBase);
  apiBaseRef.current = apiBase;
  const loadGenRef = useRef(0);

  function loadBranches(refresh: boolean) {
    if (!projectPath) {
      setBranches([]);
      setLoadError(false);
      return;
    }

    const gen = ++loadGenRef.current;
    setLoading(true);
    setLoadError(false);
    void fetchBranches(projectPath, apiBaseRef.current, { refresh })
      .then((items) => {
        if (gen !== loadGenRef.current) return;
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
          if (preferred) onChangeRef.current(preferred.name);
        }
      })
      .catch(() => {
        if (gen !== loadGenRef.current) return;
        setBranches((prev) => {
          if (prev.length === 0) setLoadError(true);
          return prev;
        });
      })
      .finally(() => {
        if (gen === loadGenRef.current) setLoading(false);
      });
  }

  useEffect(() => {
    if (!projectPath) {
      setBranches([]);
      setLoadError(false);
      return;
    }
    loadBranches(true);
  }, [projectPath, apiBase]);

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (next && projectPath) {
      loadBranches(true);
    }
  };

  const safeValue = isNuncioSessionBranch(value) ? undefined : value;
  const selected = branches.find((branch) => branch.name === safeValue);
  const label = disabled
    ? 'Base branch'
    : loadError
      ? 'Branch unavailable'
      : selected?.name ?? safeValue ?? 'Base branch';

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          className={cn(
            asText
              ? 'picker-trigger-text max-w-[160px]'
              : 'composer-picker-trigger h-8 gap-1.5 px-2.5 max-w-[160px]',
          )}
          disabled={disabled}
        >
          {!asText && <GitBranch className="size-3.5 shrink-0 text-muted-foreground" />}
          <span
            className={cn('truncate text-ui-lg', asText ? '' : safeValue ? 'font-medium' : 'text-muted-foreground')}
          >
            {label}
          </span>
          <ChevronDown className="size-3 opacity-70" data-icon="inline-end" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[280px] p-0" align="start">
        <Command>
          <CommandInput placeholder="Search base branches…" />
          <CommandList>
            {loading && branches.length === 0 ? (
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
                        <span className="ml-auto text-ui-xs text-muted-foreground">default</span>
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
