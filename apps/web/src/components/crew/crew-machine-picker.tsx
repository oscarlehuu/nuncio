import { useEffect, useState } from 'react';
import { ChevronDown, Server } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { currentMachine, fetchHubMachines, type HubMachine } from '../../lib/hub-api';

/**
 * Chooses which tailnet machine will OWN a Crew run created from Home. The run
 * executes entirely on the selected machine — its worktree, writer lease, and
 * verifier sandbox — so picking a machine here is pure routing, not distributed
 * execution. `null` means the machine this page already talks to (local).
 *
 * Renders nothing on single-machine installs (hub off or no peers), so the Home
 * composer is unchanged for anyone not running a hub.
 */
export function CrewMachinePicker({
  value,
  onChange,
  disabled,
}: {
  value: string | null;
  onChange: (machine: string | null) => void;
  disabled?: boolean;
}) {
  const [machines, setMachines] = useState<HubMachine[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchHubMachines()
      .then((res) => {
        if (!cancelled) setMachines(res.hubMode ? res.machines : []);
      })
      .catch(() => {
        if (!cancelled) setMachines([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!machines || machines.length === 0) return null;

  const localName = currentMachine() ?? machines.find((m) => m.self)?.name ?? null;
  const activeName = value ?? localName ?? '';
  const label = value ?? localName ?? 'This machine';

  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          disabled={disabled}
          aria-label={`Run on machine: ${label}`}
          className="h-7 max-w-[180px] gap-1.5 px-2 text-ui text-muted-foreground hover:text-foreground"
        >
          <Server aria-hidden className="size-3.5" />
          <span className="truncate">{label}</span>
          <ChevronDown aria-hidden className="size-3 opacity-70" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-[200px]">
        <DropdownMenuRadioGroup
          value={activeName}
          onValueChange={(name) => onChange(name === localName ? null : name)}
        >
          {machines.map((m) => (
            <DropdownMenuRadioItem key={m.name} value={m.name}>
              <span className="flex-1 truncate">{m.name}</span>
              {m.name === localName ? (
                <span className="ml-2 text-ui-xs text-muted-foreground">this page</span>
              ) : null}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
