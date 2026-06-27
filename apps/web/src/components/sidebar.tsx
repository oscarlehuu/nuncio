import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ModeToggle } from '@/components/mode-toggle';
import { cn } from '@/lib/utils';
import type { Session } from '../lib/api';
import { relativeTime, statusLabel } from '../lib/api';
import { StatusDot } from './status-dot';

interface SidebarProps {
  sessions: Session[];
  activeId: string | null;
  onSelect: (id: string | null) => void;
  onNew: () => void;
}

export function Sidebar({ sessions, activeId, onSelect, onNew }: SidebarProps) {
  return (
    <div className="flex flex-col h-full bg-sidebar text-sidebar-foreground">
      <div className="p-4 pb-3 shrink-0">
        <div className="flex items-center gap-2.5 px-1">
          <div className="size-[26px] rounded-[7px] bg-gradient-to-br from-primary to-primary/70 flex items-center justify-center font-serif font-semibold text-primary-foreground text-sm">
            N
          </div>
          <span className="font-semibold text-[14.5px] tracking-tight">Nuncio</span>
          <div className="ml-auto">
            <ModeToggle />
          </div>
        </div>
        <nav className="mt-3.5 flex flex-col gap-px">
          <Button
            variant="secondary"
            onClick={onNew}
            className="w-full justify-start"
          >
            <Plus data-icon="inline-start" />
            <span>New Agent</span>
          </Button>
        </nav>
      </div>

      <div className="flex-1 overflow-y-auto px-2 pb-2 min-h-0">
        <div className="flex items-center justify-between px-2 py-3 sticky top-0 bg-sidebar z-10">
          <span className="text-[10px] uppercase tracking-widest text-muted-foreground font-semibold">
            Recent
          </span>
        </div>
        <div className="flex flex-col gap-0.5">
          {sessions.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => onSelect(s.id)}
              className={cn(
                'touch-target relative flex items-start gap-2 p-2 rounded-md text-left w-full transition-colors',
                activeId === s.id
                  ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                  : 'hover:bg-sidebar-accent/60',
              )}
            >
              {activeId === s.id && (
                <span className="absolute left-0 top-1.5 bottom-1.5 w-0.5 bg-sidebar-ring rounded-sm" />
              )}
              <StatusDot status={s.status} />
              <div className="min-w-0 flex-1">
                <div className="text-[13px] text-sidebar-foreground truncate">{s.title}</div>
                <div className="text-[11px] text-muted-foreground truncate mt-0.5">
                  {s.preview ?? statusLabel(s.status)} · {relativeTime(s.updatedAt)}
                </div>
              </div>
            </button>
          ))}
          {sessions.length === 0 && (
            <p className="px-2 text-muted-foreground text-xs">No sessions yet</p>
          )}
        </div>
      </div>
    </div>
  );
}
