import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowRightLeft, Loader2, RefreshCw, Search } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Badge } from '@/components/ui/badge';
import { ProjectPicker } from './project-picker';
import { resolveWorkspacePreference } from '../lib/project-preference';
import {
  fetchLocalCursorSessions,
  handoffSession,
  HandoffApiError,
  type LocalCursorSession,
} from '../lib/handoff-api';
import {
  formatHandoffSessionTime,
  groupHandoffSessionsByDay,
} from '../lib/handoff-session-groups';
import { cn } from '@/lib/utils';

interface HandoffPickerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImported: (sessionId: string) => void;
  initialWorkspace?: string;
}

function HandoffSessionRow({
  item,
  active,
  onSelect,
}: {
  item: LocalCursorSession;
  active: boolean;
  onSelect: (chatId: string) => void;
}) {
  const imported = item.alreadyImported;
  return (
    <li>
      <button
        type="button"
        role="option"
        aria-selected={active}
        onClick={() => onSelect(item.chatId)}
        className={cn(
          'relative w-full text-left rounded-lg border px-3 py-3 transition-colors',
          imported && !active && 'border-success/35 bg-success/5 hover:bg-success/10',
          imported && active && 'border-success bg-success/10 ring-1 ring-success/30',
          !imported && active && 'border-primary bg-primary/5',
          !imported && !active && 'border-border hover:bg-muted/50',
        )}
      >
        {imported ? (
          <span
            aria-hidden
            className="absolute left-0 top-2 bottom-2 w-0.5 rounded-sm bg-success"
          />
        ) : null}
        <div className="flex items-start justify-between gap-2">
          <span className="font-medium text-sm line-clamp-1">{item.title}</span>
          <span className="text-xs text-muted-foreground shrink-0 tabular-nums">
            {formatHandoffSessionTime(item.updatedAt)}
          </span>
        </div>
        {item.preview ? (
          <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{item.preview}</p>
        ) : null}
        <div className="flex gap-2 mt-2">
          {imported ? (
            <Badge variant="outline" className="text-xs border-success/40 bg-success/15 text-success">
              On Nuncio
            </Badge>
          ) : null}
          <Badge variant="outline" className="text-xs">
            {item.messageCount} messages
          </Badge>
        </div>
      </button>
    </li>
  );
}

function workspaceFolderName(path: string | undefined): string {
  if (!path) return 'this folder';
  const parts = path.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

export function HandoffPicker({
  open,
  onOpenChange,
  onImported,
  initialWorkspace,
}: HandoffPickerProps) {
  const preferred = resolveWorkspacePreference();
  const [workspace, setWorkspace] = useState<string | undefined>(
    initialWorkspace ?? preferred.projectPath,
  );
  const [sessions, setSessions] = useState<LocalCursorSession[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  useEffect(() => {
    if (open && initialWorkspace) {
      setWorkspace(initialWorkspace);
    }
  }, [open, initialWorkspace]);

  useEffect(() => {
    if (!open) {
      setSearchQuery('');
    }
  }, [open]);

  const loadSessions = useCallback(async (ws: string, opts?: { silent?: boolean }) => {
    setLoading(true);
    try {
      const items = await fetchLocalCursorSessions(ws);
      setSessions(items);
      setSelectedId((prev) => {
        if (prev && items.some((s) => s.chatId === prev)) return prev;
        return items[0]?.chatId ?? null;
      });
      if (opts?.silent) {
        toast.success('Refreshed');
      }
    } catch (err) {
      const message =
        err instanceof HandoffApiError || err instanceof Error
          ? err.message
          : 'Failed to load Cursor chats';
      toast.error(message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open || !workspace) {
      setSessions([]);
      setSelectedId(null);
      return;
    }
    void loadSessions(workspace);
  }, [open, workspace, loadSessions]);

  const filteredSessions = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return sessions;
    return sessions.filter(
      (s) =>
        s.title.toLowerCase().includes(q) ||
        (s.preview?.toLowerCase().includes(q) ?? false),
    );
  }, [sessions, searchQuery]);

  const selected = sessions.find((s) => s.chatId === selectedId) ?? null;
  const sessionGroups = groupHandoffSessionsByDay(filteredSessions);
  const folderLabel = workspaceFolderName(workspace);

  const handleImport = async () => {
    if (!selected || !workspace) return;
    setImporting(true);
    try {
      if (selected.alreadyImported && selected.nuncioSessionId) {
        onImported(selected.nuncioSessionId);
        onOpenChange(false);
        return;
      }
      const session = await handoffSession({
        cursorChatId: selected.chatId,
        workspace,
        title: selected.title,
      });
      onImported(session.id);
      onOpenChange(false);
      toast.success('Imported Cursor chat');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Import failed');
    } finally {
      setImporting(false);
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="max-h-[85vh] gap-2 overflow-y-auto rounded-t-xl">
        <SheetHeader className="px-4 pt-4 pb-1">
          <SheetTitle className="flex items-center gap-2 text-base">
            <ArrowRightLeft className="size-4" />
            Continue on mobile
          </SheetTitle>
          <SheetDescription className="text-[13px] leading-snug">
            Pick an in-progress Cursor chat from this Mac to continue on your phone.
          </SheetDescription>
        </SheetHeader>

        <div className="space-y-3 px-4 pb-6">
          <div className="flex items-center gap-2">
            <div className="min-w-0 flex-1">
              <ProjectPicker value={workspace} onChange={setWorkspace} />
            </div>
            <Button
              variant="outline"
              size="icon"
              className="shrink-0"
              disabled={!workspace || loading}
              aria-label="Refresh chat list"
              onClick={() => workspace && void loadSessions(workspace, { silent: true })}
            >
              <RefreshCw className={cn('size-4', loading && 'animate-spin')} />
            </Button>
            <Button
              className="shrink-0"
              disabled={!selected || !workspace || importing || loading}
              onClick={() => void handleImport()}
            >
              {importing ? (
                <>
                  <Loader2 className="size-4 animate-spin" data-icon="inline-start" />
                  Importing…
                </>
              ) : selected?.alreadyImported ? (
                'Open'
              ) : (
                'Import'
              )}
            </Button>
          </div>

          {workspace && !loading && sessions.length > 0 ? (
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search chats…"
                className="pl-8"
                aria-label="Search chats"
              />
            </div>
          ) : null}

          {loading ? (
            <div className="flex items-center justify-center py-8 text-muted-foreground gap-2">
              <Loader2 className="size-4 animate-spin" />
              Scanning Cursor chats…
            </div>
          ) : !workspace ? (
            <p className="text-sm text-muted-foreground py-4">
              Pick a project folder to see Cursor chats on this Mac.
            </p>
          ) : sessions.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4">
              No Cursor agent chats found for &ldquo;{folderLabel}&rdquo;. Open a chat in Cursor
              first.
            </p>
          ) : filteredSessions.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4">
              No chats match &ldquo;{searchQuery.trim()}&rdquo;.
            </p>
          ) : (
            <div className="space-y-4" role="listbox" aria-label="Cursor chats">
              {sessionGroups.map((group) => (
                <section key={group.dayKey} aria-label={group.label}>
                  <h3 className="sticky top-0 z-10 bg-background/95 backdrop-blur px-1 py-1.5 mb-2 text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
                    {group.label}
                  </h3>
                  <ul className="space-y-2">
                    {group.items.map((item) => (
                      <HandoffSessionRow
                        key={item.chatId}
                        item={item}
                        active={item.chatId === selectedId}
                        onSelect={setSelectedId}
                      />
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
