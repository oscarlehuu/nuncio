import { useMemo, useState, type ReactNode } from 'react';
import {
  Archive,
  ChevronDown,
  ChevronRight,
  FolderGit2,
  LayoutGrid,
  Inbox,
  MessageSquare,
  Plus,
  Repeat,
  Ship,
  RotateCcw,
  Search,
  Settings,
  Sparkles,
  Trash2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { MachineSwitcher } from './machine-switcher';
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import type { Session } from '../lib/api';
import { relativeTime, statusLabel } from '../lib/api';
import { projectDisplayName } from '../lib/projects';
import { providerMeta } from '../lib/model-providers';
import {
  groupSessionsByProject,
  groupSessionsByStatus,
  loadCollapsedGroups,
  loadSidebarGroupBy,
  saveCollapsedGroups,
  saveSidebarGroupBy,
  type SessionGroup,
  type SidebarGroupBy,
} from '../lib/group-sessions';
import { ProviderIcon } from './provider-icon';
import { StatusDot } from './status-dot';

interface SidebarProps {
  sessions: Session[];
  /** Archived sessions shown in the Archived tab. Optional for back-compat. */
  archivedSessions?: Session[];
  activeId: string | null;
  onSelect: (id: string | null) => void;
  onNew: () => void;
  /** Fleet — the cockpit landing (rung 3 home). */
  onHome?: () => void;
  /** Desktop multi-session workbench (the unified grid). */
  onGrid?: () => void;
  /** Autopilot — the loops fleet (rung 2). */
  onAutopilot?: () => void;
  /** Inbox — the attention queue (rung 3). */
  onInbox?: () => void;
  /** Unacked attention count for the Inbox badge; 0 = no badge. */
  inboxUnacked?: number;
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
  onHome,
  onGrid,
  onAutopilot,
  onInbox,
  inboxUnacked = 0,
  onSettings,
  onChangelog,
  onArchive,
  onRestore,
  onDelete,
}: SidebarProps) {
  const [view, setView] = useState<View>('recent');
  const [query, setQuery] = useState('');
  const [pendingDelete, setPendingDelete] = useState<Session | null>(null);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => loadCollapsedGroups());

  const recentGroups = useMemo(() => groupSessionsByProject(sessions), [sessions]);
  const projectGroups = useMemo(
    () => recentGroups.filter((g) => g.projectPath !== null),
    [recentGroups],
  );
  const chatGroup = useMemo(
    () => recentGroups.find((g) => g.projectPath === null) ?? null,
    [recentGroups],
  );
  const [groupBy, setGroupBy] = useState<SidebarGroupBy>(() => loadSidebarGroupBy());
  const statusGroups = useMemo(() => groupSessionsByStatus(sessions), [sessions]);
  const changeGroupBy = (next: SidebarGroupBy) => {
    setGroupBy(next);
    saveSidebarGroupBy(next);
  };

  const toggleGroup = (key: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      saveCollapsedGroups(next);
      return next;
    });
  };

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
        <div className="flex items-center px-1.5 pt-0.5">
          <span className="text-ui-lg font-semibold tracking-tight text-muted-foreground">Nuncio</span>
        </div>
        <MachineSwitcher />
        <nav className="mt-2.5 flex flex-col gap-px">
          {onHome ? (
            <button
              type="button"
              onClick={onHome}
              className="group flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-ui-lg text-sidebar-foreground transition-colors hover:bg-sidebar-accent/60 active:scale-[0.99]"
            >
              <Ship className="size-4 shrink-0 text-muted-foreground group-hover:text-sidebar-foreground" />
              <span className="flex-1">Fleet</span>
            </button>
          ) : null}
          <button
            type="button"
            onClick={onNew}
            className="group flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-ui-lg text-sidebar-foreground transition-colors hover:bg-sidebar-accent/60 active:scale-[0.99]"
          >
            <Plus className="size-4 shrink-0 text-muted-foreground group-hover:text-sidebar-foreground" />
            <span className="flex-1">New Agent</span>
            <kbd className="hidden shrink-0 items-center gap-0.5 rounded border border-sidebar-border/70 px-1 font-mono text-ui-xs text-muted-foreground md:inline-flex">
              ⌘N
            </kbd>
          </button>
          {onGrid ? (
            <button
              type="button"
              onClick={onGrid}
              className="group hidden w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-ui-lg text-sidebar-foreground transition-colors hover:bg-sidebar-accent/60 active:scale-[0.99] md:flex"
            >
              <LayoutGrid className="size-4 shrink-0 text-muted-foreground group-hover:text-sidebar-foreground" />
              <span className="flex-1">Workbench</span>
            </button>
          ) : null}
          {onAutopilot ? (
            <button
              type="button"
              onClick={onAutopilot}
              className="group flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-ui-lg text-sidebar-foreground transition-colors hover:bg-sidebar-accent/60 active:scale-[0.99]"
            >
              <Repeat className="size-4 shrink-0 text-muted-foreground group-hover:text-sidebar-foreground" />
              <span className="flex-1">Autopilot</span>
            </button>
          ) : null}
          {onInbox ? (
            <button
              type="button"
              onClick={onInbox}
              className="group flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-ui-lg text-sidebar-foreground transition-colors hover:bg-sidebar-accent/60 active:scale-[0.99]"
            >
              <Inbox className="size-4 shrink-0 text-muted-foreground group-hover:text-sidebar-foreground" />
              <span className="flex-1">Inbox</span>
              {inboxUnacked > 0 && (
                <span
                  aria-label={`${inboxUnacked} items need you`}
                  className="inline-flex min-w-[1.25rem] shrink-0 items-center justify-center rounded-full bg-warning/15 px-1.5 text-ui-xs font-semibold text-warning tabular-nums"
                >
                  {inboxUnacked > 99 ? '99+' : inboxUnacked}
                </span>
              )}
            </button>
          ) : null}
        </nav>

        <div
          role="tablist"
          aria-label="Session list view"
          className="mt-2.5 flex items-center gap-1 px-1"
        >
          <button
            role="tab"
            type="button"
            aria-selected={view === 'recent'}
            onClick={() => setView('recent')}
            className={cn(
              'rounded-md px-2 py-1 text-ui-lg transition-colors',
              view === 'recent'
                ? 'bg-sidebar-accent font-medium text-sidebar-foreground'
                : 'text-muted-foreground hover:bg-sidebar-accent/50 hover:text-sidebar-foreground',
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
              'flex items-center gap-1 rounded-md px-2 py-1 text-ui-lg transition-colors',
              view === 'archived'
                ? 'bg-sidebar-accent font-medium text-sidebar-foreground'
                : 'text-muted-foreground hover:bg-sidebar-accent/50 hover:text-sidebar-foreground',
            )}
          >
            Archived
            {archivedSessions.length > 0 && (
              <span className="text-ui-xs tabular-nums text-muted-foreground/70">
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
              className="h-8 pl-7 text-ui-lg"
            />
          </div>
        </div>
      )}

      <div className="flex-1 overflow-y-auto px-2 pb-2 min-h-0">
        <div className="flex items-center justify-between px-2 pt-4 pb-2 sticky top-0 bg-sidebar z-10">
          <span className="text-ui-sm text-muted-foreground">
            {view === 'recent' ? 'Recent' : 'Archived'}
          </span>
          {view === 'recent' ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label="Group sessions by"
                  className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-ui-sm text-muted-foreground transition-colors hover:bg-sidebar-accent/50 hover:text-sidebar-foreground"
                >
                  {groupBy === 'status' ? 'Status' : 'Repository'}
                  <ChevronDown className="size-3" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => changeGroupBy('repository')}>
                  Repository
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => changeGroupBy('status')}>Status</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </div>
        <div className="flex flex-col gap-0.5">
          {view === 'recent' ? (
            groupBy === 'status' ? (
              statusGroups.map((group) => (
                <RecentGroupSection
                  key={group.key}
                  group={group}
                  collapsed={collapsedGroups.has(group.key)}
                  onToggle={() => toggleGroup(group.key)}
                  activeId={activeId}
                  onSelect={onSelect}
                  onArchive={onArchive}
                  icon={<StatusDot status={group.sessions[0].status} className="shrink-0" />}
                />
              ))
            ) : (
            <>
              {projectGroups.length > 0 && (
                <>
                  <div className="px-2 pt-2 pb-1">
                    <span
                      data-testid="recent-divider-projects"
                      className="text-ui-sm text-muted-foreground"
                    >
                      Projects
                    </span>
                  </div>
                  {projectGroups.map((group) => (
                    <RecentGroupSection
                      key={group.key}
                      group={group}
                      collapsed={collapsedGroups.has(group.key)}
                      onToggle={() => toggleGroup(group.key)}
                      activeId={activeId}
                      onSelect={onSelect}
                      onArchive={onArchive}
                      icon={<FolderGit2 className="size-3.5 text-muted-foreground shrink-0" />}
                    />
                  ))}
                </>
              )}
              {chatGroup && chatGroup.sessions.length > 0 && (
                <>
                  <div
                    className={cn(
                      'flex items-center gap-1.5 px-2 pb-1',
                      projectGroups.length > 0 ? 'pt-4' : 'pt-1',
                    )}
                  >
                    <MessageSquare className="size-3 text-muted-foreground shrink-0" />
                    <span
                      data-testid="recent-divider-chat"
                      className="text-ui-sm text-muted-foreground"
                    >
                      Chat
                    </span>
                  </div>
                  <div className="flex flex-col gap-0.5">
                    {chatGroup.sessions.map((s) => (
                      <RecentRow
                        key={s.id}
                        session={s}
                        active={activeId === s.id}
                        onSelect={onSelect}
                        onArchive={onArchive}
                      />
                    ))}
                  </div>
                </>
              )}
            </>
            )
          ) : (
            filteredArchived.map((s) => (
              <ArchivedRow
                key={s.id}
                session={s}
                active={activeId === s.id}
                onSelect={onSelect}
                onRestore={onRestore}
                onDelete={(sess) => setPendingDelete(sess)}
              />
            ))
          )}
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

interface RecentGroupSectionProps {
  group: SessionGroup;
  collapsed: boolean;
  onToggle: () => void;
  activeId: string | null;
  onSelect: (id: string | null) => void;
  onArchive?: (id: string) => void | Promise<void>;
  icon?: ReactNode;
}

function RecentGroupSection({
  group,
  collapsed,
  onToggle,
  activeId,
  onSelect,
  onArchive,
  icon,
}: RecentGroupSectionProps) {
  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={!collapsed}
        className="flex items-center gap-1.5 w-full px-2 py-1.5 rounded-md text-left hover:bg-sidebar-accent/40 transition-colors"
      >
        {collapsed ? (
          <ChevronRight className="size-3.5 text-muted-foreground shrink-0" />
        ) : (
          <ChevronDown className="size-3.5 text-muted-foreground shrink-0" />
        )}
        {icon}
        <span className="text-ui font-medium text-sidebar-foreground truncate">{group.name}</span>
        <span className="text-ui-sm tabular-nums text-muted-foreground ml-auto shrink-0">
          {group.sessions.length}
        </span>
      </button>
      {!collapsed && (
        <div className="flex flex-col gap-0.5">
          {group.sessions.map((s) => (
            <RecentRow
              key={s.id}
              session={s}
              active={activeId === s.id}
              onSelect={onSelect}
              onArchive={onArchive}
            />
          ))}
        </div>
      )}
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

/** Show a status dot only when the row wants the eye: it's live or needs attention. */
function needsStatusDot(status: Session['status']): boolean {
  return status === 'RUNNING' || status === 'ERROR';
}

function RecentRow({ session, active, onSelect, onArchive }: RecentRowProps) {
  const showArchive = onArchive && canArchiveRow(session.status);
  const showDot = needsStatusDot(session.status);
  return (
    <div
      className={cn(
        'touch-target relative flex items-start gap-2 px-2 py-1.5 rounded-md w-full transition-colors group',
        active ? 'bg-sidebar-accent text-sidebar-accent-foreground' : 'hover:bg-sidebar-accent/60',
      )}
    >
      <button
        type="button"
        onClick={() => onSelect(session.id)}
        className="min-w-0 flex-1 text-left"
        aria-label={`Open ${session.title}`}
      >
        <div className="flex items-center gap-1.5">
          {showDot && <StatusDot status={session.status} className="shrink-0" />}
          <span className="text-ui-lg text-sidebar-foreground truncate">{session.title}</span>
          <span className="ml-auto shrink-0 text-ui-sm tabular-nums text-muted-foreground">
            {relativeTime(session.updatedAt)}
          </span>
        </div>
        <div className="text-ui-sm text-muted-foreground truncate mt-0.5 flex items-center gap-1">
          <span
            aria-label={`${providerMeta(session.provider).name} provider`}
            className="shrink-0 leading-none"
          >
            <ProviderIcon providerId={session.provider} className="size-3" />
          </span>
          <span className="truncate">{session.preview ?? statusLabel(session.status)}</span>
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
        'touch-target relative flex items-start gap-2 px-2 py-1.5 rounded-md w-full transition-colors group',
        active ? 'bg-sidebar-accent text-sidebar-accent-foreground' : 'hover:bg-sidebar-accent/60',
      )}
    >
      <button
        type="button"
        onClick={() => onSelect(session.id)}
        className="min-w-0 flex-1 text-left"
        aria-label={`Open ${session.title}`}
      >
        <div className="flex items-center gap-1.5">
          <span className="text-ui-lg text-sidebar-foreground truncate">{session.title}</span>
          <span className="ml-auto shrink-0 text-ui-sm tabular-nums text-muted-foreground">
            {relativeTime(session.updatedAt)}
          </span>
        </div>
        <div className="text-ui-sm text-muted-foreground truncate mt-0.5 flex items-center gap-1">
          <span
            aria-label={`${providerMeta(session.provider).name} provider`}
            className="shrink-0 leading-none"
          >
            <ProviderIcon providerId={session.provider} className="size-3" />
          </span>
          <span className="truncate">
            {projectDisplayName(session.projectPath) ?? session.preview ?? statusLabel(session.status)}
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
