import { useEffect, useMemo, useRef, useState } from 'react';
import { Archive, ArrowRightLeft, Check, FolderGit2, GitBranch, Pencil, RotateCcw, Send, Square, Trash2, X } from 'lucide-react';
import type { Session, SessionEvent } from '../lib/api';
import { projectDisplayName } from '../lib/projects';
import { FALLBACK_PROVIDERS, modelById, prettyModelName, type ModelProvider } from '../lib/model-providers';
import { useContextUsage } from '../lib/use-context-usage';
import { ContextUsageButton } from './context-usage-button';
import { Transcript } from './session-transcript';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';

export { Transcript, buildMessages } from './session-transcript';

interface SessionDetailProps {
  session: Session;
  events: SessionEvent[];
  providers?: ModelProvider[];
  onSteer: (message: string) => Promise<void>;
  onPause: () => Promise<void>;
  onArchive: () => Promise<void>;
  /** Restore an archived session back to IDLE. Only invoked when status === 'ARCHIVED'. */
  onRestore?: (id: string) => void | Promise<void>;
  /** Permanently delete an archived session. Only invoked when status === 'ARCHIVED'. */
  onDelete?: (id: string) => void | Promise<void>;
  /** Rename the session. */
  onRename?: (id: string, title: string) => void | Promise<void>;
  /** Open Continue on mobile picker (SDK Cursor sessions only). */
  onContinueOnMobile?: () => void;
  /** Cursor IDE may still be running this CLI handoff chat on the host. */
  machineActive?: boolean;
  steering?: boolean;
  lifecycleBusy?: boolean;
}

export function SessionDetail({
  session,
  events,
  providers,
  onSteer,
  onPause,
  onArchive,
  onRestore,
  onDelete,
  onRename,
  onContinueOnMobile,
  machineActive = false,
  steering,
  lifecycleBusy,
}: SessionDetailProps) {
  const [steerText, setSteerText] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const pendingScrollToBottomRef = useRef(true);
  const streaming = session.status === 'RUNNING';
  const isRunning = session.status === 'RUNNING';
  const isArchived = session.status === 'ARCHIVED';
  const steerDisabled =
    session.status === 'RUNNING' ||
    session.status === 'ARCHIVED' ||
    steering ||
    lifecycleBusy;
  const canArchive = !isArchived;
  const canRestore = isArchived && !!onRestore;
  const canDelete = isArchived && !!onDelete;

  const catalog = providers && providers.length > 0 ? providers : FALLBACK_PROVIDERS;
  const entry = useMemo(
    () => (session.model ? modelById(catalog)[session.model] : undefined),
    [catalog, session.model],
  );
  const modelName = entry
    ? prettyModelName(entry.name)
    : session.model && session.model !== 'Composer'
      ? session.model
      : session.provider === 'cursor' ? 'Cursor' : session.provider === 'pi' ? 'Pi' : 'Default';
  const showContinueOnMobile =
    session.provider === 'cursor' &&
    session.cursorBackend !== 'cli' &&
    !!onContinueOnMobile;
  const repoName = projectDisplayName(session.projectPath) ?? projectDisplayName(session.workspace);
  const branchName = session.branch;
  const contextUsage = useContextUsage(events);

  useEffect(() => {
    pendingScrollToBottomRef.current = true;
  }, [session.id]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (pendingScrollToBottomRef.current || nearBottom) {
      el.scrollTop = el.scrollHeight;
      if (el.scrollHeight > el.clientHeight) {
        pendingScrollToBottomRef.current = false;
      }
    }
  }, [events.length, session.id]);

  const handleSteer = async () => {
    const text = steerText.trim();
    if (!text || steerDisabled) return;
    await onSteer(text);
    setSteerText('');
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  };

  const handleRenameSave = async () => {
    const trimmed = titleDraft.trim();
    if (!trimmed || !onRename) {
      setEditingTitle(false);
      setTitleDraft('');
      return;
    }
    await onRename(session.id, trimmed);
    setEditingTitle(false);
    setTitleDraft('');
  };

  return (
    <section className="flex-1 flex flex-col min-h-0">
      <TooltipProvider>
      <header className="shrink-0 flex items-center gap-3 px-4 md:px-5 py-3 border-b border-border bg-card/80 backdrop-blur min-h-[52px]">
        {/* Centered title with tooltip + rename */}
        <div className="flex-1 min-w-0 flex justify-center items-center">
          {editingTitle ? (
            <div className="flex items-center gap-1.5 max-w-[60%]">
              <Input
                value={titleDraft}
                onChange={(e) => setTitleDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    handleRenameSave();
                  } else if (e.key === 'Escape') {
                    setEditingTitle(false);
                    setTitleDraft('');
                  }
                }}
                autoFocus
                className="h-7 text-sm"
                data-testid="rename-input"
              />
              <Button
                size="icon-sm"
                variant="ghost"
                onClick={handleRenameSave}
                aria-label="Save name"
                disabled={!titleDraft.trim()}
              >
                <Check className="size-3.5" />
              </Button>
              <Button
                size="icon-sm"
                variant="ghost"
                onClick={() => { setEditingTitle(false); setTitleDraft(''); }}
                aria-label="Cancel rename"
              >
                <X className="size-3.5" />
              </Button>
            </div>
          ) : (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  className="group flex items-center gap-1.5 max-w-[50%] cursor-text"
                  onClick={() => {
                    if (!onRename) return;
                    setTitleDraft(session.title);
                    setEditingTitle(true);
                  }}
                  data-testid="session-title"
                >
                  <span className="font-medium truncate text-sm text-center">{session.title}</span>
                  {onRename && (
                    <Pencil className="size-3 text-muted-foreground/0 group-hover:text-muted-foreground transition-colors shrink-0" />
                  )}
                </button>
              </TooltipTrigger>
              <TooltipContent className="max-w-[400px]">
                <p className="text-xs">{session.title}</p>
                {onRename && <p className="text-[10px] text-muted-foreground mt-0.5">Click to rename</p>}
              </TooltipContent>
            </Tooltip>
          )}
        </div>

        {/* Right-side actions */}
        <div className="flex items-center gap-1 shrink-0">
            {showContinueOnMobile && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={onContinueOnMobile}
                    disabled={lifecycleBusy}
                    aria-label="Continue on mobile"
                  >
                    <ArrowRightLeft />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Continue on mobile</TooltipContent>
              </Tooltip>
            )}
            {canArchive && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => void onArchive()}
                    disabled={lifecycleBusy}
                    aria-label="Archive session"
                  >
                    <Archive />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Archive session</TooltipContent>
              </Tooltip>
            )}
            {canRestore && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => void onRestore?.(session.id)}
                    disabled={lifecycleBusy}
                    aria-label="Restore session"
                  >
                    <RotateCcw />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Restore session</TooltipContent>
              </Tooltip>
            )}
            {canDelete && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => setConfirmDelete(true)}
                    disabled={lifecycleBusy}
                    aria-label="Delete session"
                    className="text-destructive hover:text-destructive"
                  >
                    <Trash2 />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Delete session permanently</TooltipContent>
              </Tooltip>
            )}
          </div>
      </header>
      </TooltipProvider>

      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 md:px-8 min-h-0">
        <div className="max-w-[760px] mx-auto">
          <Transcript events={events} streaming={streaming} />
        </div>
      </div>

      <div className="shrink-0 px-4 md:px-5 pt-2.5 pb-3 md:pb-4">
        <div className="max-w-[760px] mx-auto rounded-xl border border-border/50 bg-muted/20 transition-colors focus-within:border-border/80">
          <Textarea
            value={steerText}
            onChange={(e) => setSteerText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void handleSteer();
              }
            }}
            disabled={steerDisabled}
            placeholder={
              session.status === 'ARCHIVED'
                ? 'Session archived — steering disabled'
                : machineActive
                  ? 'Cursor is running this chat on your Mac — wait for it to finish…'
                  : session.status === 'RUNNING'
                    ? 'Agent is running — wait for idle or stop first…'
                    : 'Steer the agent — add context, change direction, ask a question…'
            }
            className="min-h-[44px] resize-none border-0 shadow-none bg-transparent focus-visible:ring-0 focus-visible:border-0 text-[14px]"
          />
          <div className="flex items-center justify-between gap-2 px-3 pb-2">
            <div className="flex items-center gap-3 min-w-0">
              <span className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
                <span className="size-1.5 rounded-full bg-primary" />
                {modelName}
              </span>
              <ContextUsageButton usage={contextUsage} />
            </div>
            {isRunning ? (
              <Button
                size="icon"
                variant="destructive"
                aria-label="Stop session"
                onClick={() => void onPause()}
                disabled={lifecycleBusy}
                className="shrink-0 rounded-full"
              >
                <Square className="size-3.5" />
              </Button>
            ) : (
              <Button
                size="icon"
                aria-label="Send"
                onClick={() => void handleSteer()}
                disabled={steerDisabled || !steerText.trim()}
                className="shrink-0 rounded-full"
              >
                <Send className="size-4" />
              </Button>
            )}
          </div>
          <div
            data-testid="session-footer"
            className="flex items-center gap-3 px-3 py-1.5 border-t border-border/30 text-[11px] text-muted-foreground"
          >
            {repoName && (
              <span className="flex items-center gap-1 shrink-0">
                <FolderGit2 className="size-3" />
                {repoName}
              </span>
            )}
            {branchName && (
              <span className="flex items-center gap-1 shrink-0">
                <GitBranch className="size-3" />
                {branchName}
              </span>
            )}
            <span className="flex items-center gap-1 shrink-0">
              <span className={`size-1.5 rounded-full ${machineActive ? 'bg-info animate-pulse' : 'bg-success'}`} />
              Local
            </span>
            {machineActive && (
              <span className="flex items-center gap-1 shrink-0 text-info">
                Running on machine
              </span>
            )}
          </div>
        </div>
      </div>

      <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete session</DialogTitle>
            <DialogDescription>
              Permanently delete “{session.title}”? This removes the session and its full
              transcript. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmDelete(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                setConfirmDelete(false);
                void onDelete?.(session.id);
              }}
            >
              Delete forever
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
