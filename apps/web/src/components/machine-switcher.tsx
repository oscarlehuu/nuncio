import { useEffect, useState } from 'react';
import { Server } from 'lucide-react';
import { currentMachine, fetchHubMachines, machineHref, type HubMachine } from '../lib/hub-api';

/**
 * Sidebar control for hub mode: lists the tailnet machines reachable through
 * this hub and links to each at /m/<machine>/. Links are plain anchors so a
 * cmd/ctrl+click opens a machine in a new tab — that is how you work on several
 * machines in parallel. Renders nothing when this server is not a hub.
 */
export function MachineSwitcher() {
  const [machines, setMachines] = useState<HubMachine[] | null>(null);
  const active = currentMachine();

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

  return (
    <div className="mt-3">
      <div className="flex items-center gap-1.5 px-1 mb-1 text-ui-xs uppercase tracking-widest text-muted-foreground font-semibold">
        <Server className="size-3" />
        Machines
      </div>
      <div className="flex flex-col gap-px">
        {machines.map((machine) => {
          const isActive = active === machine.name || (active === null && machine.self);
          return (
            <a
              key={machine.name}
              href={machineHref(machine.name)}
              aria-current={isActive ? 'page' : undefined}
              className={
                'flex items-center justify-between rounded-[5px] px-2 py-1 text-ui transition-colors ' +
                (isActive
                  ? 'bg-sidebar-accent text-sidebar-foreground font-medium'
                  : 'text-muted-foreground hover:text-sidebar-foreground hover:bg-sidebar-accent/40')
              }
            >
              <span className="truncate">{machine.name}</span>
              {machine.self ? <span className="text-ui-xs opacity-60 ml-2">this hub</span> : null}
            </a>
          );
        })}
      </div>
    </div>
  );
}
