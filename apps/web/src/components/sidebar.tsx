import { useMemo, useState } from 'react';
import { Archive, Plus, RotateCcw, Search, Settings, Sparkles, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ModeToggle } from '@/components/mode-toggle';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import type { Session } from '../lib/api';
import { relativeTime, statusLabel } from '../lib/api';
import { projectDisplayName } from '../lib/projects';
import { providerMeta } from '../lib/model-providers';
import { ProviderIcon } from './provider-icon';
import { StatusDot } from './status-dot';

interface SidebarProps {
  sessions: Session[];
  /** Archived sessions shown in the Archived tab. Optional for back-compat. */
  archivedSessions?: Session[];
  activeId: string | null;
  onSelect: (id: string | null) => void;
  onNew: () => void;
  onSettings?: () => void;
  onChangelog?: () => void;
  onArchive?: (id: string) => void | Promise<void>;
  onRestore?: (id: string) => void | Promise<void>;
  onDelete?: (id: string) => void | Promise<void>;
}

type View = 'recent' | 'archived';

export function Sidebar({
  sessions,
  archivedSessions = [],
  activeId,
  onSelect,
  onNew,
  onSettings,
  onChangelog,
  onArchive,
  onRestore,
  onDelete,
}: SidebarProps) {
  const [view, setView] = useState<View>('recent');
  const [query, setQuery] = useState('');
  const [pendingDelete, setPendingDelete] = useState<Session | null>(null);

  const filteredArchived = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return archivedSessions;
    return archivedSessions.filter(
      (s) =>
        s.title.toLowerCase().includes(q) ||
        s.prompt.toLowerCase().includes(q) ||
        (s.preview ?? '').toLowerCase().includes(q),
    );
  }, [archivedSessions, query]);

  const confirmDelete = () => {
    if (!pendingDelete || !onDelete) return;
    void onDelete(pendingDelete.id);
    setPendingDelete(null);
  };

  return (
    <div className="flex flex-col h-full bg-sidebar text-sidebar-foreground">
      <div className="p-4 pb-3 shrink-0">
        <div className="flex items-center gap-2.5 px-1">
          <img
            src="/nuncio-mark.png"
            alt="Nuncio"
            className="size-[26px] rounded-[7px] ring-1 ring-white/10"
          />
          <span className="font-semibold text-[14.5px] tracking-tight">Nuncio</span>
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

        <div
          role="tablist"
          aria-label="Session list view"
          className="mt-3 grid grid-cols-2 gap-1 rounded-md bg-sidebar-accent/40 p-0.5"
        >
          <button
            role="tab"
            type="button"
            aria-selected={view === 'recent'}
            onClick={() => setView('recent')}
            className={cn(
              'rounded-[5px] px-2 py-1 text-[12px] font-medium transition-colors',
              view === 'recent'
                ? 'bg-sidebar text-sidebar-foreground shadow-sm'
                : 'text-muted-foreground hover:text-sidebar-foreground',
            )}
          >
            Recent
          </button>
          <button
            role="tab"
            type="button"
            aria-selected={view === 'archived'}
            onClick={() => setView('archived')}
            className={cn(
              'rounded-[5px] px-2 py-1 text-[12px] font-medium transition-colors flex items-center justify-center gap-1',
              view === 'archived'
                ? 'bg-sidebar text-sidebar-foreground shadow-sm'
                : 'text-muted-foreground hover:text-sidebar-foreground',
            )}
          >
            <Archive className="size-3" />
            Archived
            {archivedSessions.length > 0 && (
              <span className="ml-0.5 text-[10px] tabular-nums text-muted-foreground">
                {archivedSessions.length}
              </span>
            )}
          </button>
        </div>
      </div>

      {view === 'archived' && (
        <div className="px-3 pb-1 shrink-0">
          <div className="relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground pointer-events-none" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search archived…"
              aria-label="Search archived sessions"
              className="h-8 pl-7 text-[13px]"
            />
          </div>
        </div>
      )}

      <div className="flex-1 overflow-y-auto px-2 pb-2 min-h-0">
        <div className="flex items-center justify-between px-2 py-3 sticky top-0 bg-sidebar z-10">
          <span className="text-[10px] uppercase tracking-widest text-muted-foreground font-semibold">
            {view === 'recent' ? 'Recent' : 'Archived'}
          </span>
        </div>
        <div className="flex flex-col gap-0.5">
          {view === 'recent'
            ? sessions.map((s) => (
                <RecentRow
                  key={s.id}
                  session={s}
                  active={activeId === s.id}
                  onSelect={onSelect}
                  onArchive={onArchive}
                />
              ))
            : filteredArchived.map((s) => (
                <ArchivedRow
                  key={s.id}
                  session={s}
                  active={activeId === s.id}
                  onSelect={onSelect}
                  onRestore={onRestore}
                  onDelete={(sess) => setPendingDelete(sess)}
                />
              ))}
          {view === 'recent' && sessions.length === 0 && (
            <p className="px-2 text-muted-foreground text-xs">No sessions yet</p>
          )}
          {view === 'archived' && filteredArchived.length === 0 && (
            <p className="px-2 text-muted-foreground text-xs">
              {query.trim()
                ? `No archived sessions match “${query.trim()}”`
                : 'No archived sessions'}
            </p>
          )}
        </div>
      </div>

      <footer
        data-sidebar-footer
        className="shrink-0 border-t border-sidebar-border p-3 flex items-center justify-end gap-1"
        style={{ paddingBottom: 'calc(0.75rem + env(safe-area-inset-bottom, 0px))' }}
      >
        {onChangelog && (
          <Button
            variant="ghost"
            size="icon"
            onClick={onChangelog}
            aria-label="What's new"
            className="size-8"
          >
            <Sparkles className="size-4" />
          </Button>
        )}
        {onSettings && (
          <Button variant="ghost" size="icon" onClick={onSettings} aria-label="Settings" className="size-8">
            <Settings className="size-4" />
          </Button>
        )}
        <ModeToggle />
      </footer>

      <Dialog open={pendingDelete !== null} onOpenChange={(open) => !open && setPendingDelete(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete session</DialogTitle>
            <DialogDescription>
              Permanently delete “{pendingDelete?.title}”? This removes the session and its full
              transcript. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingDelete(null)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={confirmDelete}>
              Delete forever
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

interface RecentRowProps {
  session: Session;
  active: boolean;
  onSelect: (id: string | null) => void;
  onArchive?: (id: string) => void | Promise<void>;
}

/** FSM: only IDLE / PAUSED / ERROR can transition to ARCHIVED. */
function canArchiveRow(status: Session['status']): boolean {
  return status === 'IDLE' || status === 'PAUSED' || status === 'ERROR';
}

function RecentRow({ session, active, onSelect, onArchive }: RecentRowProps) {
  const showArchive = onArchive && canArchiveRow(session.status);
  return (
    <div
      className={cn(
        'touch-target relative flex items-start gap-2 p-2 rounded-md w-full transition-colors group',
        active
          ? 'bg-sidebar-accent text-sidebar-accent-foreground'
          : 'hover:bg-sidebar-accent/60',
      )}
    >
      {active && (
        <span className="absolute left-0 top-1.5 bottom-1.5 w-0.5 bg-sidebar-ring rounded-sm" />
      )}
      <StatusDot status={session.status} className="mt-1" />
      <button
        type="button"
        onClick={() => onSelect(session.id)}
        className="min-w-0 flex-1 text-left"
        aria-label={`Open ${session.title}`}
      >
        <div className="text-[13px] text-sidebar-foreground truncate">{session.title}</div>
        <div className="text-[11px] text-muted-foreground truncate mt-0.5 flex items-center gap-1">
          <span
            aria-label={`${providerMeta(session.provider).name} provider`}
            className="shrink-0 leading-none"
          >
            <ProviderIcon providerId={session.provider} className="size-3" />
          </span>
          <span className="truncate">
            {projectDisplayName(session.projectPath) ?? session.preview ?? statusLabel(session.status)} · {relativeTime(session.updatedAt)}
          </span>
        </div>
      </button>
      {showArchive && (
        <div className="flex items-center gap-0.5 shrink-0 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
          <Button
            variant="ghost"
            size="icon-sm"
            className="size-7"
            aria-label={`Archive ${session.title}`}
            onClick={(e) => {
              e.stopPropagation();
              void onArchive?.(session.id);
            }}
          >
            <Archive className="size-3.5" />
          </Button>
        </div>
      )}
    </div>
  );
}

interface ArchivedRowProps {
  session: Session;
  active: boolean;
  onSelect: (id: string | null) => void;
  onRestore?: (id: string) => void | Promise<void>;
  onDelete: (session: Session) => void;
}

function ArchivedRow({ session, active, onSelect, onRestore, onDelete }: ArchivedRowProps) {
  return (
    <div
      className={cn(
        'touch-target relative flex items-start gap-2 p-2 rounded-md w-full transition-colors group',
        active
          ? 'bg-sidebar-accent text-sidebar-accent-foreground'
          : 'hover:bg-sidebar-accent/60',
      )}
    >
      {active && (
        <span className="absolute left-0 top-1.5 bottom-1.5 w-0.5 bg-sidebar-ring rounded-sm" />
      )}
      <StatusDot status={session.status} className="mt-1" />
      <button
        type="button"
        onClick={() => onSelect(session.id)}
        className="min-w-0 flex-1 text-left"
        aria-label={`Open ${session.title}`}
      >
        <div className="text-[13px] text-sidebar-foreground truncate">{session.title}</div>
        <div className="text-[11px] text-muted-foreground truncate mt-0.5 flex items-center gap-1">
          <span
            aria-label={`${providerMeta(session.provider).name} provider`}
            className="shrink-0 leading-none"
          >
            <ProviderIcon providerId={session.provider} className="size-3" />
          </span>
          <span className="truncate">
            {projectDisplayName(session.projectPath) ?? session.preview ?? statusLabel(session.status)} · {relativeTime(session.updatedAt)}
          </span>
        </div>
      </button>
      <div className="flex items-center gap-0.5 shrink-0 opacity-60 group-hover:opacity-100 transition-opacity">
        {onRestore && (
          <Button
            variant="ghost"
            size="icon-sm"
            className="size-7"
            aria-label={`Restore ${session.title}`}
            onClick={() => onRestore(session.id)}
          >
            <RotateCcw className="size-3.5" />
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon-sm"
          className="size-7 text-destructive hover:text-destructive"
          aria-label={`Delete ${session.title}`}
          onClick={() => onDelete(session)}
        >
          <Trash2 className="size-3.5" />
        </Button>
      </div>
    </div>
  );
}
