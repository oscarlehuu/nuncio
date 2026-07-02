import { useEffect, useMemo, useRef, useState } from 'react';
import { Archive, ArrowRightLeft, Check, Ellipsis, FolderGit2, FolderTree, GitBranch, Globe2, PanelRightClose, PanelRightOpen, Pause, Pencil, RotateCcw, Send, Square, SquareTerminal, Trash2, X } from 'lucide-react';
import { toast } from 'sonner';
import type { ProviderRequestDecision, Session, SessionEvent } from '../lib/api';
import { InteractionApiError, interactionErrorMessage, respondInteraction } from '../lib/api';
import { derivePendingUserInput } from '../lib/derive-pending-user-input';
import { projectDisplayName } from '../lib/projects';
import { FALLBACK_PROVIDERS, modelById, prettyModelName, type ModelProvider } from '../lib/model-providers';
import { isCodexApprovalEngine } from '../lib/codex-approval-engine';
import { useContextUsage } from '../lib/use-context-usage';
import {
  loadInspectorPreference,
  saveInspectorPreference,
  type InspectorTool,
} from '../lib/inspector-preference';
import { ContextUsageButton } from './context-usage-button';
import { PrPanel } from './pr-panel';
import { Transcript } from './session-transcript';
import { ReviewChanges } from './review-changes';
import { PendingUserInputBanner } from './pending-user-input-banner';
import { ApprovalModePicker, type ApprovalMode } from './approval-mode-picker';
import { BrowserPanel, getDesktopBrowserBridge } from './browser-panel';
import { FileExplorerPanel } from './file-explorer-panel';
import { TerminalDock } from './terminal-dock';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
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
  approvalMode?: ApprovalMode;
  onApprovalModeChange?: (mode: ApprovalMode) => void | Promise<void>;
  onRespondProviderRequest?: (
    requestId: string,
    decision: ProviderRequestDecision,
  ) => void | Promise<void>;
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
  approvalMode = 'full-access',
  onApprovalModeChange,
  onRespondProviderRequest,
  steering,
  lifecycleBusy,
}: SessionDetailProps) {
  const [steerText, setSteerText] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  const [respondingRequestId, setRespondingRequestId] = useState<string | null>(null);

  const workingDir = session.worktreePath ?? session.workspace ?? session.projectPath ?? undefined;
  const hasGitContext = !!(session.worktreePath || session.branch || session.projectPath);
  const hasDesktopBrowser = !!getDesktopBrowserBridge();
  const toolAvailable = (tool: InspectorTool | null): tool is InspectorTool =>
    tool === 'terminal' ||
    (tool === 'scm' && hasGitContext) ||
    (tool === 'files' && !!workingDir) ||
    (tool === 'browser' && hasDesktopBrowser);
  const firstAvailableTool = (): InspectorTool => {
    if (hasGitContext) return 'scm';
    if (workingDir) return 'files';
    return 'terminal';
  };

  // Restore the inspector dock (open + last tab) per device; a persisted tab this
  // session cannot show (e.g. browser outside the desktop app) falls back.
  const [initialInspector] = useState(() => loadInspectorPreference());
  const restoredTool = toolAvailable(initialInspector.tool)
    ? initialInspector.tool
    : initialInspector.open
      ? firstAvailableTool()
      : null;
  const [panelOpen, setPanelOpen] = useState(initialInspector.open);
  const [activeTool, setActiveTool] = useState<InspectorTool | null>(restoredTool);
  const [terminalMounted, setTerminalMounted] = useState(restoredTool === 'terminal');
  const [fileExplorerMounted, setFileExplorerMounted] = useState(restoredTool === 'files');

  useEffect(() => {
    saveInspectorPreference({ version: 1, open: panelOpen, tool: activeTool });
  }, [panelOpen, activeTool]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pendingScrollToBottomRef = useRef(true);
  const streaming = session.status === 'RUNNING';
  const isRunning = session.status === 'RUNNING';
  const isArchived = session.status === 'ARCHIVED';
  const pendingUserInput = useMemo(() => derivePendingUserInput(events), [events]);
  const pendingRequestIds = useMemo(
    () => new Set(pendingUserInput.map((item) => item.requestId)),
    [pendingUserInput],
  );
  const hasPendingUserInput = pendingUserInput.length > 0;
  const interactionSupported = session.supportsInteraction ?? false;
  const providerLabel = session.provider === 'cursor' ? 'Cursor' : session.provider === 'pi' ? 'Pi' : session.provider;
  const showApprovalMode =
    !!onApprovalModeChange && isCodexApprovalEngine(session.provider, session.model);
  const steerDisabled =
    session.status === 'RUNNING' ||
    session.status === 'ARCHIVED' ||
    steering ||
    lifecycleBusy ||
    hasPendingUserInput;
  const showHeaderPause = !isRunning && session.status !== 'PAUSED' && !isArchived;
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
  const contextUsage = useContextUsage(events, entry?.contextWindow);

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
    setSteerText('');
    try {
      await onSteer(text);
    } catch (error) {
      setSteerText((current) => (current.trim() ? current : text));
      throw error;
    }
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

  const handleRespondProviderRequest = async (
    requestId: string,
    decision: ProviderRequestDecision,
  ) => {
    if (!onRespondProviderRequest || respondingRequestId) return;
    setRespondingRequestId(requestId);
    try {
      await onRespondProviderRequest(requestId, decision);
    } finally {
      setRespondingRequestId(null);
    }
  };

  return (
    <section className="flex-1 flex min-h-0">
      <TooltipProvider>
      <div className="flex-1 min-w-0 flex flex-col min-h-0">
      <header className="shrink-0 relative flex items-center gap-3 px-4 md:px-5 py-3 border-b border-border bg-card/80 backdrop-blur min-h-[52px]">
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
                {onRename && <p className="text-ui-xs text-muted-foreground mt-0.5">Click to rename</p>}
              </TooltipContent>
            </Tooltip>
          )}
        </div>

        <div className="absolute right-4 md:right-5 top-1/2 -translate-y-1/2 flex items-center gap-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Toggle panel"
                aria-pressed={panelOpen}
                onClick={() => {
                  setPanelOpen((open) => {
                    if (!open) setActiveTool((tool) => tool ?? firstAvailableTool());
                    return !open;
                  });
                }}
              >
                {panelOpen ? <PanelRightClose /> : <PanelRightOpen />}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">Panel</TooltipContent>
          </Tooltip>

          {(showContinueOnMobile || showHeaderPause || canArchive || canRestore || canDelete) && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" aria-label="Session actions">
                  <Ellipsis />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {showContinueOnMobile && (
                  <DropdownMenuItem
                    onClick={onContinueOnMobile}
                    disabled={lifecycleBusy}
                    aria-label="Continue on mobile"
                  >
                    <ArrowRightLeft />
                    Continue on mobile
                  </DropdownMenuItem>
                )}
                {showHeaderPause && (
                  <DropdownMenuItem
                    onClick={() => void onPause()}
                    disabled={lifecycleBusy}
                    aria-label="Pause session"
                  >
                    <Pause />
                    Pause session
                  </DropdownMenuItem>
                )}
                {canArchive && (
                  <DropdownMenuItem
                    onClick={() => void onArchive()}
                    disabled={lifecycleBusy}
                    aria-label="Archive session"
                  >
                    <Archive />
                    Archive session
                  </DropdownMenuItem>
                )}
                {canRestore && (
                  <DropdownMenuItem
                    onClick={() => void onRestore?.(session.id)}
                    disabled={lifecycleBusy}
                    aria-label="Restore session"
                  >
                    <RotateCcw />
                    Restore session
                  </DropdownMenuItem>
                )}
                {canDelete && (
                  <DropdownMenuItem
                    onClick={() => setConfirmDelete(true)}
                    disabled={lifecycleBusy}
                    aria-label="Delete session"
                    variant="destructive"
                  >
                    <Trash2 />
                    Delete session permanently
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </header>

      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 md:px-8 min-h-0">
        <div className="max-w-[760px] mx-auto">
          <Transcript
            events={events}
            streaming={streaming}
            pendingRequestIds={pendingRequestIds}
            respondingRequestId={respondingRequestId}
            onRespondProviderRequest={
              onRespondProviderRequest ? handleRespondProviderRequest : undefined
            }
          />
        </div>
      </div>

      <div className="shrink-0 px-4 md:px-5 pt-2.5 pb-3 md:pb-4">
        <div className="max-w-[760px] mx-auto">
          <PendingUserInputBanner
            pending={pendingUserInput}
            supported={interactionSupported}
            providerLabel={providerLabel}
            onRespond={async (requestId, response) => {
              try {
                await respondInteraction(session.id, requestId, response);
              } catch (error) {
                const message =
                  error instanceof InteractionApiError
                    ? error.message
                    : interactionErrorMessage(501, 'Failed to submit response');
                toast.error(message);
              }
            }}
          />
        </div>
        <div className="max-w-[760px] mx-auto rounded-xl border border-border/70 bg-card shadow-sm transition-shadow focus-within:ring-2 focus-within:ring-ring/40">
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
                : hasPendingUserInput
                  ? 'Answer the question above to continue…'
                  : machineActive
                    ? 'Cursor is running this chat on your Mac — wait for it to finish…'
                    : session.status === 'RUNNING'
                      ? 'Agent is running — wait for idle or stop first…'
                      : 'Steer the agent — add context, change direction, ask a question…'
            }
            className="min-h-[44px] resize-none border-0 shadow-none bg-transparent focus-visible:ring-0 focus-visible:border-0 text-body"
          />
          <div className="flex items-center justify-between gap-2 px-3 pb-2">
            <div className="flex items-center gap-3 min-w-0 flex-wrap">
              <span className="flex items-center gap-1.5 text-ui text-muted-foreground">
                <span className="size-1.5 rounded-full bg-primary" />
                {modelName}
              </span>
              <ContextUsageButton usage={contextUsage} />
              {showApprovalMode ? (
                <ApprovalModePicker
                  value={approvalMode}
                  onChange={onApprovalModeChange}
                  disabled={lifecycleBusy}
                  surface="embedded"
                />
              ) : null}
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
                className="shrink-0 rounded-full transition-transform active:scale-95 disabled:opacity-40"
              >
                <Send className="size-4" />
              </Button>
            )}
          </div>
          <div
            data-testid="session-footer"
            className="flex items-center gap-3 px-3 py-1.5 border-t border-border/30 text-ui-sm text-muted-foreground"
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
            {machineActive && !hasPendingUserInput && (
              <span className="flex items-center gap-1 shrink-0 text-info">
                Running on machine
              </span>
            )}
          </div>
        </div>
      </div>

      </div>

      {panelOpen && (
        <aside
          className={
            activeTool === 'browser'
              ? 'w-[520px] max-w-[48vw] shrink-0 border-l border-border bg-card/40 flex flex-col min-h-0'
              : 'w-[360px] shrink-0 border-l border-border bg-card/40 flex flex-col min-h-0'
          }
        >
          <div className="flex items-center gap-1 px-2 py-1.5 border-b border-border">
            {hasGitContext && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => setActiveTool('scm')}
                    aria-label="Toggle source control"
                    aria-pressed={activeTool === 'scm'}
                    data-active={activeTool === 'scm'}
                  >
                    <GitBranch />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom">Source control</TooltipContent>
              </Tooltip>
            )}
            {workingDir && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => {
                      setFileExplorerMounted(true);
                      setActiveTool('files');
                    }}
                    aria-label="Toggle files"
                    aria-pressed={activeTool === 'files'}
                    data-active={activeTool === 'files'}
                  >
                    <FolderTree />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom">Files</TooltipContent>
              </Tooltip>
            )}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => {
                    if (terminalMounted && activeTool === 'terminal') {
                      setActiveTool(null);
                    } else {
                      setTerminalMounted(true);
                      setActiveTool('terminal');
                    }
                  }}
                  aria-label="Toggle terminal"
                  aria-pressed={activeTool === 'terminal'}
                  data-active={activeTool === 'terminal'}
                >
                  <SquareTerminal />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">Terminal</TooltipContent>
            </Tooltip>
            {hasDesktopBrowser && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => setActiveTool('browser')}
                    aria-label="Toggle browser"
                    aria-pressed={activeTool === 'browser'}
                    data-active={activeTool === 'browser'}
                  >
                    <Globe2 />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom">Browser</TooltipContent>
              </Tooltip>
            )}
            <span className="ml-1 text-sm font-medium truncate">
              {activeTool === 'scm'
                ? 'Source Control'
                : activeTool === 'files'
                  ? 'Files'
                  : activeTool === 'browser'
                    ? 'Browser'
                    : 'Terminal'}
            </span>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => setPanelOpen(false)}
              aria-label="Close panel"
              className="ml-auto"
            >
              <X className="size-3.5" />
            </Button>
          </div>

          {activeTool === 'scm' && hasGitContext && (
            <div className="flex-1 min-h-0">
              <div className="h-full overflow-y-auto">
                <div className="border-b border-border/60 bg-card/40">
                  <ReviewChanges sessionId={session.id} />
                </div>
                <PrPanel session={session} />
              </div>
            </div>
          )}

          {activeTool === 'files' && fileExplorerMounted && (
            <div className="flex-1 min-h-0">
              <FileExplorerPanel root={workingDir} />
            </div>
          )}

          {activeTool === 'browser' && (
            <div className="flex-1 min-h-0">
              <BrowserPanel sessionId={session.id} />
            </div>
          )}

          {terminalMounted && (
            <div
              className="flex-1 min-h-0 bg-card/60"
              style={activeTool === 'terminal' ? undefined : { display: 'none' }}
            >
              <TerminalDock cwd={workingDir} />
            </div>
          )}
        </aside>
      )}
      </TooltipProvider>

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
