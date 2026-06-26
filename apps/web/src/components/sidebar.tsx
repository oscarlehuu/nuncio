import type { Session } from '../lib/api';
import { relativeTime, statusLabel } from '../lib/api';
import { StatusDot } from './status-dot';

interface SidebarProps {
  sessions: Session[];
  activeId: string | null;
  open?: boolean;
  onSelect: (id: string | null) => void;
  onNew: () => void;
}

export function Sidebar({ sessions, activeId, open = false, onSelect, onNew }: SidebarProps) {
  return (
    <aside
      className={`sidebar-drawer flex flex-col bg-bg-1 border-r border-border-soft w-[260px] min-h-0 md:static md:translate-x-0 md:shadow-none ${open ? 'open' : ''}`}
    >
      <div className="p-4 pb-3 shrink-0">
        <div className="flex items-center gap-2.5 px-1">
          <div className="w-[26px] h-[26px] rounded-[7px] bg-gradient-to-br from-accent to-[#b88858] flex items-center justify-center font-serif font-semibold text-[#1a1208] text-sm">
            N
          </div>
          <span className="font-semibold text-[14.5px] tracking-tight">Nuncio</span>
        </div>
        <nav className="mt-3.5 flex flex-col gap-px">
          <button
            type="button"
            onClick={onNew}
            className="touch-target flex items-center gap-2 px-2 py-2 md:py-1.5 rounded-md text-accent bg-accent-soft text-[13px] w-full text-left"
          >
            <PlusIcon />
            <span>New Agents</span>
          </button>
        </nav>
      </div>

      <div className="flex-1 overflow-y-auto px-2 pb-2 min-h-0">
        <div className="flex items-center justify-between px-2 py-3 sticky top-0 bg-bg-1 z-10">
          <span className="text-[10px] uppercase tracking-widest text-text-3 font-semibold">Recent</span>
        </div>
        <div className="flex flex-col gap-0.5">
          {sessions.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => onSelect(s.id)}
              className={`touch-target relative flex items-start gap-2 p-2.5 md:p-2 rounded-md text-left w-full transition-colors ${
                activeId === s.id ? 'bg-bg-2' : 'hover:bg-bg-2'
              }`}
            >
              {activeId === s.id && (
                <span className="absolute left-0 top-1.5 bottom-1.5 w-0.5 bg-accent rounded-sm" />
              )}
              <StatusDot status={s.status} />
              <div className="min-w-0 flex-1">
                <div className="text-[13px] text-text-0 truncate">{s.title}</div>
                <div className="text-[11px] text-text-2 truncate mt-0.5">
                  {s.preview ?? statusLabel(s.status)} · {relativeTime(s.updatedAt)}
                </div>
              </div>
            </button>
          ))}
          {sessions.length === 0 && (
            <p className="px-2 text-text-3 text-xs">No sessions yet</p>
          )}
        </div>
      </div>
    </aside>
  );
}

function PlusIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="w-[15px] h-[15px]">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}
