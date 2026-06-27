import { useEffect, useState } from 'react';
import { ChevronDown, GitBranch } from 'lucide-react';
import { fetchBranches, type Branch } from '../lib/projects';
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
  const disabled = !projectPath;

  useEffect(() => {
    if (!projectPath) {
      setBranches([]);
      return;
    }

    let cancelled = false;
    setLoading(true);
    void fetchBranches(projectPath)
      .then((items) => {
        if (cancelled) return;
        setBranches(items);
        if (!value) {
          const preferred = items.find((branch) => branch.isDefault) ?? items[0];
          if (preferred) onChange(preferred.name);
        }
      })
      .catch(() => {
        if (!cancelled) setBranches([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [projectPath, onChange, value]);

  const selected = branches.find((branch) => branch.name === value);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          className="h-8 gap-1.5 px-2.5 max-w-[160px]"
          disabled={disabled}
        >
          <GitBranch className="size-3.5 shrink-0 text-muted-foreground" />
          <span className={`truncate text-[13px] ${value ? 'font-medium' : 'text-muted-foreground'}`}>
            {disabled ? 'Branch' : selected?.name ?? value ?? 'Branch'}
          </span>
          <ChevronDown data-icon="inline-end" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[280px] p-0" align="start">
        <Command>
          <CommandInput placeholder="Search branches…" />
          <CommandList>
            {loading ? (
              <div className="py-6 text-center text-sm text-muted-foreground">Loading branches…</div>
            ) : (
              <>
                <CommandEmpty>No branch found.</CommandEmpty>
                <CommandGroup heading="Branches">
                  {branches.map((branch) => (
                    <CommandItem
                      key={branch.name}
                      value={branch.name}
                      onSelect={() => {
                        onChange(branch.name);
                        setOpen(false);
                      }}
                      data-checked={branch.name === value ? 'true' : undefined}
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
