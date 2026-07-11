import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Archive, ArrowRightLeft, Check, Ellipsis, FolderGit2, FolderTree, GitBranch, Globe2, PanelRightClose, PanelRightOpen, Pause, Pencil, RotateCcw, Send, Square, SquareTerminal, Trash2, Users, X } from 'lucide-react';
import { toast } from 'sonner';
import type { MessageAttachment, ProviderRequestDecision, Session, SessionEvent, TaskDto } from '../lib/api';
import {
  InteractionApiError,
  interactionErrorMessage,
  respondInteraction,
  fetchChildTasks,
  fetchSessionLineage,
  startMultitask,
  startMultitaskFromQueue,
  markTaskReviewed,
  cancelTask,
  retryTask,
  updateTask,
  startTaskNow,
  type SessionLineage,
} from '../lib/api';
import type { ModelOptionsMap } from '../lib/model-options';
import { DEFAULT_HOLD_SECONDS, holdSecondsRemaining } from '../lib/subagent-hold';
import { derivePendingQueuedSteers } from '../lib/transcript-build-blocks';
import { useComposerAttachments } from '../lib/use-composer-attachments';
import { AttachButton, AttachmentTray } from './attachment-tray';
import { derivePendingUserInput } from '../lib/derive-pending-user-input';
import { isComposingEvent } from '../lib/keyboard';
import { useStickToBottom } from '../lib/use-stick-to-bottom';
import { deriveVerifyStatus } from '../lib/derive-verify-status';
import { VerifyChip } from './verify-chip';
import { projectDisplayName } from '../lib/projects';
import { FALLBACK_PROVIDERS, modelById, prettyModelName, type ModelProvider } from '../lib/model-providers';
import { useContextUsage } from '../lib/use-context-usage';
import { resolveTranscriptLinkTarget } from '../lib/transcript-link-target';
import {
  loadInspectorPreference,
  saveInspectorPreference,
  type InspectorTool,
  type ScmSegment,
} from '../lib/inspector-preference';
import { ContextUsageButton } from './context-usage-button';
import { ScmPanel } from './forge/scm-panel';
import { Transcript } from './session-transcript';
import { PendingUserInputBanner } from './pending-user-input-banner';
import { SubagentsPanel } from './subagents-panel';
import { QueuedSteersPanel } from './queued-steers-panel';
import { BrowserPanel, getDesktopBrowserBridge } from './browser-panel';
import { FileExplorerPanel } from './file-explorer-panel';
import { ChunkErrorBoundary } from './chunk-error-boundary';
// Lazy: pulls in @xterm (~480 kB) and only mounts when the terminal tool opens.
const TerminalDock = lazy(() =>
  import('./terminal-dock').then((m) => ({ default: m.TerminalDock })),
);
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
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';

export { Transcript, buildMessages } from './session-transcript';

function multitaskPromptFromCommand(text: string): string | null {
  const trimmed = text.trim();
  if (!/^\/multitask(?:\s|$)/i.test(trimmed)) return null;
  return trimmed.replace(/^\/multitask(?:\s+)?/i, '').trim();
}

interface SessionDetailProps {
  session: Session;
  events: SessionEvent[];
  providers?: ModelProvider[];
  onSteer: (message: string, attachments?: MessageAttachment[]) => Promise<void>;
  onPause: () => Promise<void>;
  /** Abort the live run (providers with interrupt support); falls back to pause. */
  onInterrupt?: () => Promise<void>;
  onArchive: () => Promise<void>;
  /** Restore an archived session back to IDLE. Only invoked when status === 'ARCHIVED'. */
  onRestore?: (id: string) => void | Promise<void>;
  /** Permanently delete an archived session. Only invoked when status === 'ARCHIVED'. */
  onDelete?: (id: string) => void | Promise<void>;
  /** Rename the session. */
  onRename?: (id: string, title: string) => void | Promise<void>;
  /** Navigate to a related session from lineage, digest, or subagent UI. */
  onOpenSession?: (id: string) => void;
  /** Open Continue on mobile picker (SDK Cursor sessions only). */
  onContinueOnMobile?: () => void;
  /** Cursor IDE may still be running this CLI handoff chat on the host. */
  machineActive?: boolean;
  onRespondProviderRequest?: (
    requestId: string,
    decision: ProviderRequestDecision,
  ) => void | Promise<void>;
  steering?: boolean;
  lifecycleBusy?: boolean;
  /** Rendered in the header's right control group, before the panel toggle
   * (e.g. the grid's restore button). In flow — the far-left column belongs
   * to the sidebar hover rail and absolute corners collide with it. */
  headerActions?: React.ReactNode;
  /** Older events exist on the server beyond the loaded window. */
  hasEarlier?: boolean;
  /** Page the previous window of history into the transcript. */
  onLoadEarlier?: () => void | Promise<void>;
  /** Focus the composer when the view opens / the session changes (desktop only),
   *  so the user can type straight away. */
  autoFocusComposer?: boolean;
}

type SessionRef = SessionLineage['children'][number];

function lineageStatusDot(status: SessionRef['status']) {
  if (status === 'RUNNING') return 'bg-info animate-pulse';
  if (status === 'ERROR') return 'bg-destructive';
  if (status === 'IDLE') return 'bg-success';
  return 'bg-muted-foreground/50';
}

function LineageChips({
  parent,
  childSessions,
  onOpenSession,
}: {
  parent: SessionRef | null;
  childSessions: SessionRef[];
  onOpenSession?: (id: string) => void;
}) {
  if (!parent && childSessions.length === 0) return null;
  return (
    <div className="ml-2 flex min-w-0 items-center gap-1.5" data-testid="lineage-chips">
      {parent && (
        <button
          type="button"
          data-testid="lineage-parent-chip"
          onClick={() => onOpenSession?.(parent.id)}
          className="inline-flex max-w-[180px] items-center gap-1 rounded-md border border-border/60 bg-card px-2 py-0.5 text-ui-sm text-muted-foreground shadow-e0 transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          title={`From ${parent.title}`}
        >
          <span aria-hidden>↳</span>
          <span className="truncate">from {parent.title}</span>
        </button>
      )}

      {childSessions.length > 0 && (
        <Popover>
          <PopoverTrigger asChild>
            <button
              type="button"
              data-testid="lineage-children-chip"
              className="inline-flex items-center gap-1 rounded-md border border-border/60 bg-card px-2 py-0.5 text-ui-sm text-muted-foreground shadow-e0 transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Users className="size-3" aria-hidden />
              {childSessions.length} {childSessions.length === 1 ? 'subagent' : 'subagents'}
            </button>
          </PopoverTrigger>
          <PopoverContent align="center" className="w-72 p-2" data-testid="lineage-children-popover">
            <div className="px-2 pb-1 text-ui-sm font-medium text-foreground">Subagents</div>
            <ul className="max-h-72 overflow-y-auto">
              {childSessions.map((child) => (
                <li key={child.id}>
                  <button
                    type="button"
                    onClick={() => onOpenSession?.(child.id)}
                    className="flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-ui-sm hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <span
                      className={`size-1.5 shrink-0 rounded-full ${lineageStatusDot(child.status)}`}
                      aria-hidden
                    />
                    <span className="min-w-0 flex-1 truncate">{child.title}</span>
                    <span className="shrink-0 text-muted-foreground">{child.provider}</span>
                  </button>
                </li>
              ))}
            </ul>
          </PopoverContent>
        </Popover>
      )}
    </div>
  );
}

export function SessionDetail({
  session,
  events,
  providers,
  onSteer,
  onPause,
  onInterrupt,
  onArchive,
  onRestore,
  onDelete,
  onRename,
  onOpenSession,
  onContinueOnMobile,
  machineActive = false,
  onRespondProviderRequest,
  steering,
  lifecycleBusy,
  headerActions,
  hasEarlier = false,
  onLoadEarlier,
  autoFocusComposer = false,
}: SessionDetailProps) {
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [steerText, setSteerText] = useState('');
  const [dragActive, setDragActive] = useState(false);
  const imageAttachments = useComposerAttachments(setSteerText);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  const [respondingRequestId, setRespondingRequestId] = useState<string | null>(null);
  const [startingMultitask, setStartingMultitask] = useState(false);
  const [childTasks, setChildTasks] = useState<TaskDto[]>([]);
  // Mirror of childTasks readable inside stable callbacks (re-arm math needs the
  // task's live holdUntil without re-creating the handlers on every poll).
  const childTasksRef = useRef<TaskDto[]>([]);
  childTasksRef.current = childTasks;
  const [lineage, setLineage] = useState<SessionLineage | null>(null);

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
  const [scmSegment, setScmSegment] = useState<ScmSegment>(initialInspector.scmSegment ?? 'changes');
  const [terminalMounted, setTerminalMounted] = useState(restoredTool === 'terminal');
  const [fileExplorerMounted, setFileExplorerMounted] = useState(restoredTool === 'files');
  const [fileExplorerOpenPath, setFileExplorerOpenPath] = useState<string | null>(null);

  useEffect(() => {
    saveInspectorPreference({ version: 1, open: panelOpen, tool: activeTool, scmSegment });
  }, [panelOpen, activeTool, scmSegment]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const managedByCrew = session.verifyOwner === 'crew';
  const streaming = session.status === 'RUNNING';
  const isRunning = session.status === 'RUNNING';
  const isArchived = session.status === 'ARCHIVED';
  const pendingUserInput = useMemo(() => derivePendingUserInput(events), [events]);
  const verifyStatus = useMemo(() => deriveVerifyStatus(events), [events]);
  const pendingQueued = useMemo(() => derivePendingQueuedSteers(events), [events]);
  const pendingRequestIds = useMemo(
    () => new Set(pendingUserInput.map((item) => item.requestId)),
    [pendingUserInput],
  );
  const hasPendingUserInput = pendingUserInput.length > 0;
  const interactionSupported = session.supportsInteraction ?? false;
  const providerLabel = session.provider === 'cursor' ? 'Cursor' : session.provider === 'pi' ? 'Pi' : session.provider;
  const steerWhileRunning = session.supportsSteerWhileRunning ?? false;
  const canAttachImages = !managedByCrew && (session.supportsImages ?? false) && !isArchived;
  const steerDisabled =
    managedByCrew ||
    session.status === 'ARCHIVED' ||
    steering ||
    lifecycleBusy ||
    hasPendingUserInput;
  const showHeaderPause = !managedByCrew && session.status !== 'PAUSED' && !isArchived;
  const canArchive = !managedByCrew && !isArchived;
  const canRestore = !managedByCrew && isArchived && !!onRestore;
  const canDelete = !managedByCrew && isArchived && !!onDelete;

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
    !managedByCrew &&
    session.provider === 'cursor' &&
    session.cursorBackend !== 'cli' &&
    !!onContinueOnMobile;
  const repoName = projectDisplayName(session.projectPath) ?? projectDisplayName(session.workspace);
  const branchName = session.branch;
  const contextUsage = useContextUsage(events, entry?.contextWindow);

  useStickToBottom(scrollRef, events.length, { resetKey: session.id });

  // Land the caret in the composer when the view opens (maximize) or the user
  // switches sessions, so they can type without a click. Desktop only — never
  // pop the mobile keyboard just from opening a chat.
  useEffect(() => {
    if (!autoFocusComposer) return;
    if (!window.matchMedia?.('(pointer: fine)').matches) return;
    const el = composerRef.current;
    if (el && !el.disabled) el.focus({ preventScroll: true });
  }, [autoFocusComposer, session.id]);

  // Two guards keep the child-tasks list correct under overlapping fetches:
  //  - activeSessionIdRef is the session currently on screen. A refresh bound to
  //    an old session (e.g. an action started on session A whose handler runs
  //    after the user switched to B) is dropped — it is the LATEST call, so a
  //    token alone cannot catch it; only session identity can.
  //  - seqRef is a monotonic call token so that among refreshes for the SAME
  //    session, only the newest one commits, even if an older (poll or manual)
  //    fetch resolves out of order.
  // A call born stale (already for the wrong session at call time) returns before
  // claiming a token — otherwise it would consume the sequence and starve the
  // legitimate in-flight fetch, leaving the panel permanently empty.
  const activeSessionIdRef = useRef(session.id);
  const childTasksSeqRef = useRef(0);
  const refreshChildTasks = useCallback(async () => {
    const forSessionId = session.id;
    if (activeSessionIdRef.current !== forSessionId) return;
    const token = ++childTasksSeqRef.current;
    try {
      const tasks = await fetchChildTasks(forSessionId);
      if (activeSessionIdRef.current === forSessionId && childTasksSeqRef.current === token) {
        setChildTasks(tasks);
      }
    } catch {
      // A missing subagent list is non-fatal — the section stays hidden.
    }
  }, [session.id]);

  const refreshLineage = useCallback(async () => {
    try {
      setLineage(await fetchSessionLineage(session.id));
    } catch {
      setLineage(null);
    }
  }, [session.id]);

  useEffect(() => {
    activeSessionIdRef.current = session.id;
    setChildTasks([]);
    void refreshChildTasks();
  }, [session.id, refreshChildTasks]);

  // Poll while any child is still working so status, pending-input, and review
  // state stay live without a manual refresh; stop once all reach a terminal state.
  const hasActiveChildTasks = childTasks.some(
    (task) => task.status === 'QUEUED' || task.status === 'RUNNING',
  );
  useEffect(() => {
    if (!hasActiveChildTasks) return;
    // Guard against overlap: skip a tick if the previous fetch is still in flight,
    // so a stalled poll can't resolve after a newer one and regress the UI.
    let inFlight = false;
    const id = setInterval(() => {
      if (inFlight) return;
      inFlight = true;
      void refreshChildTasks().finally(() => {
        inFlight = false;
      });
    }, 4000);
    return () => clearInterval(id);
  }, [hasActiveChildTasks, refreshChildTasks]);

  useEffect(() => {
    setLineage(null);
    void refreshLineage();
  }, [refreshLineage]);

  const submitSteer = async (
    text: string,
    stagedItems: typeof imageAttachments.items,
    attachments: MessageAttachment[],
  ) => {
    setSteerText('');
    imageAttachments.clear();
    try {
      await onSteer(text, attachments.length > 0 ? attachments : undefined);
    } catch (error) {
      // Restore the composer so a failed send loses nothing.
      setSteerText((current) => (current.trim() ? current : text));
      imageAttachments.restore(stagedItems);
      throw error;
    }
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  };

  const submitMultitask = async (prompt: string, restoreText: string) => {
    setSteerText('');
    imageAttachments.clear();
    try {
      await startMultitask({
        parentSessionId: session.id,
        prompts: [prompt],
      });
      await refreshChildTasks();
      await refreshLineage();
    } catch (error) {
      setSteerText((current) => (current.trim() ? current : restoreText));
      toast.error(error instanceof Error ? error.message : 'Failed to start multitasking');
    }
  };

  // Fan the pending steer queue out as parallel subagents. The server drains
  // the queue as it spawns them, so nothing double-runs on sequential delivery.
  const handleStartMultitasking = async () => {
    if (startingMultitask || pendingQueued.length === 0) return;
    setStartingMultitask(true);
    try {
      await startMultitaskFromQueue(session.id);
      await refreshChildTasks();
      await refreshLineage();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to start multitasking');
    } finally {
      setStartingMultitask(false);
    }
  };

  const handleSteer = async () => {
    const text = steerText.trim();
    const stagedItems = imageAttachments.items;
    const attachments = imageAttachments.attachments;
    if ((!text && attachments.length === 0) || steerDisabled) return;
    const commandPrompt = multitaskPromptFromCommand(text);
    if (commandPrompt !== null) {
      if (attachments.length > 0) {
        toast.error('Multitasking supports text-only prompts for now');
        return;
      }
      if (!commandPrompt) {
        toast.error('Add a prompt after /multitask');
        return;
      }
      await submitMultitask(commandPrompt, text);
      return;
    }
    await submitSteer(text, stagedItems, attachments);
  };

  const handleReviewTask = useCallback(
    async (id: string) => {
      try {
        await markTaskReviewed(id);
        await refreshChildTasks();
      } catch (error) {
        toast.error(error instanceof Error ? error.message : 'Failed to mark task reviewed');
      }
    },
    [refreshChildTasks],
  );

  const handleCancelTask = useCallback(
    async (id: string) => {
      try {
        await cancelTask(id);
        await refreshChildTasks();
      } catch (error) {
        toast.error(error instanceof Error ? error.message : 'Failed to cancel task');
      }
    },
    [refreshChildTasks],
  );

  const handleRetryTask = useCallback(
    async (id: string) => {
      try {
        await retryTask(id);
        await refreshChildTasks();
      } catch (error) {
        toast.error(error instanceof Error ? error.message : 'Failed to retry task');
      }
    },
    [refreshChildTasks],
  );

  // Re-arm the launch grace window on every edit so the user keeps time to
  // reconsider — but NEVER shorten it. The configured window length lives
  // server-side and can exceed our default; if the task still has more time
  // than the default, keep that larger remainder. The server clamps to 5..600.
  const reArmSeconds = useCallback((id: string) => {
    const task = childTasksRef.current.find((t) => t.id === id);
    const remaining = task ? holdSecondsRemaining(task, Date.now()) : 0;
    return Math.ceil(Math.max(remaining, DEFAULT_HOLD_SECONDS));
  }, []);

  const handleChangeTaskModel = useCallback(
    async (id: string, provider: string, model: string, modelOptions?: ModelOptionsMap) => {
      try {
        await updateTask(id, { provider, model, modelOptions, holdSeconds: reArmSeconds(id) });
        await refreshChildTasks();
      } catch (error) {
        toast.error(error instanceof Error ? error.message : 'Failed to update task model');
      }
    },
    [refreshChildTasks, reArmSeconds],
  );

  const handlePickerOpen = useCallback((id: string) => {
    // Opening the picker alone re-arms (never shortening); don't block on it,
    // and stay quiet on failure — the countdown simply keeps running.
    void updateTask(id, { holdSeconds: reArmSeconds(id) })
      .then(() => refreshChildTasks())
      .catch(() => {});
  }, [refreshChildTasks, reArmSeconds]);

  const handleStartTaskNow = useCallback(
    async (id: string) => {
      try {
        await startTaskNow(id);
        await refreshChildTasks();
      } catch (error) {
        toast.error(error instanceof Error ? error.message : 'Failed to start task');
      }
    },
    [refreshChildTasks],
  );

  const handleRenameSave = async () => {
    const trimmed = titleDraft.trim();
    if (managedByCrew || !trimmed || !onRename) {
      setEditingTitle(false);
      setTitleDraft('');
      return;
    }
    await onRename(session.id, trimmed);
    setEditingTitle(false);
    setTitleDraft('');
  };

  const respondingRef = useRef<string | null>(null);
  const handleRespondProviderRequest = useCallback(
    async (requestId: string, decision: ProviderRequestDecision) => {
      if (!onRespondProviderRequest || respondingRef.current) return;
      respondingRef.current = requestId;
      setRespondingRequestId(requestId);
      try {
        await onRespondProviderRequest(requestId, decision);
      } finally {
        respondingRef.current = null;
        setRespondingRequestId(null);
      }
    },
    [onRespondProviderRequest],
  );

  const handleTranscriptLinkClick = useCallback((href: string) => {
    const target = resolveTranscriptLinkTarget(href, workingDir);
    if (target.kind === 'file') {
      if (!workingDir) {
        toast.error('No working directory for this session');
        return true;
      }
      setFileExplorerOpenPath(target.path);
      setFileExplorerMounted(true);
      setActiveTool('files');
      setPanelOpen(true);
      return true;
    }
    if (target.kind === 'external') {
      void openExternalBrowser(target.href).catch((error) => {
        toast.error(error instanceof Error ? error.message : String(error));
      });
      return true;
    }
    return false;
  }, [workingDir]);

  const parentRef = session.parentSessionId
    ? (lineage?.ancestors.find((item) => item.id === session.parentSessionId) ?? lineage?.ancestors[0] ?? null)
    : null;
  const childRefs = lineage?.children ?? [];

  return (
    <section
      className="flex-1 flex min-h-0"
      data-testid="session-detail"
      data-session-status={session.status}
    >
      <TooltipProvider>
      <div className="flex-1 min-w-0 flex flex-col min-h-0">
      <header className="shrink-0 relative flex items-center gap-3 px-4 md:px-5 py-3 border-b border-border bg-card min-h-[52px]">
        <div className="flex-1 min-w-0 flex justify-center items-center">
          {editingTitle && !managedByCrew ? (
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
                  className={`group flex items-center gap-1.5 max-w-[50%] ${managedByCrew ? '' : 'cursor-text'}`}
                  onClick={() => {
                    if (managedByCrew || !onRename) return;
                    setTitleDraft(session.title);
                    setEditingTitle(true);
                  }}
                  data-testid="session-title"
                >
                  <span className="font-medium truncate text-sm text-center">{session.title}</span>
                  {!managedByCrew && onRename && (
                    <Pencil className="size-3 text-muted-foreground/0 group-hover:text-muted-foreground transition-colors shrink-0" />
                  )}
                </button>
              </TooltipTrigger>
              <TooltipContent className="max-w-[400px]">
                <p className="text-xs">{session.title}</p>
                {!managedByCrew && onRename && <p className="text-ui-xs text-muted-foreground mt-0.5">Click to rename</p>}
              </TooltipContent>
            </Tooltip>
          )}
          <span className="ml-2">
            <VerifyChip status={verifyStatus} />
          </span>
          <LineageChips
            parent={parentRef}
            childSessions={childRefs}
            onOpenSession={onOpenSession}
          />
        </div>

        <div className="absolute right-4 md:right-5 top-1/2 -translate-y-1/2 flex items-center gap-1">
          {headerActions}
          {!managedByCrew && <Tooltip>
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
          </Tooltip>}

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
          {hasEarlier && onLoadEarlier && (
            <div className="flex justify-center pt-4">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7 text-xs text-muted-foreground"
                disabled={loadingEarlier}
                onClick={async () => {
                  setLoadingEarlier(true);
                  try {
                    await onLoadEarlier();
                  } finally {
                    setLoadingEarlier(false);
                  }
                }}
              >
                {loadingEarlier ? 'Loading…' : 'Load earlier history'}
              </Button>
            </div>
          )}
          <Transcript
            events={events}
            sessionId={session.id}
            streaming={streaming}
            provider={session.provider}
            showAvatar
            pendingRequestIds={pendingRequestIds}
            respondingRequestId={respondingRequestId}
            onRespondProviderRequest={
              !managedByCrew && onRespondProviderRequest
                ? handleRespondProviderRequest
                : undefined
            }
            onLinkClick={handleTranscriptLinkClick}
            onOpenSession={onOpenSession}
          />
        </div>
      </div>

      {managedByCrew ? (
        <div className="shrink-0 border-t border-border bg-card px-4 py-3 md:px-5">
          <div className="mx-auto max-w-[760px]">
            <p className="text-ui-sm font-semibold text-foreground">Managed by Crew</p>
            <p className="mt-0.5 text-ui-sm text-muted-foreground">Inspect-only member session</p>
          </div>
        </div>
      ) : (
        <div className="shrink-0 px-4 md:px-5 pt-2.5 pb-3 md:pb-4">
        <SubagentsPanel
          tasks={childTasks}
          providers={providers}
          onReview={handleReviewTask}
          onCancel={handleCancelTask}
          onRetry={handleRetryTask}
          onOpenSession={onOpenSession}
          onStartNow={handleStartTaskNow}
          onChangeModel={handleChangeTaskModel}
          onPickerOpen={handlePickerOpen}
        />
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
        <div className="max-w-[760px] mx-auto">
          <QueuedSteersPanel
            steers={pendingQueued}
            starting={startingMultitask}
            onStartMultitasking={handleStartMultitasking}
          />
        </div>
        <div
          className={`max-w-[760px] mx-auto rounded-2xl border bg-card shadow-e2 surface-lit transition-shadow focus-within:ring-2 focus-within:ring-ring/40 ${dragActive ? 'border-primary ring-2 ring-primary/40' : 'border-border/70'}`}
          onDragOver={
            canAttachImages
              ? (e) => {
                  e.preventDefault();
                  setDragActive(true);
                }
              : undefined
          }
          onDragLeave={canAttachImages ? () => setDragActive(false) : undefined}
          onDrop={
            canAttachImages
              ? (e) => {
                  e.preventDefault();
                  setDragActive(false);
                  void imageAttachments.addFromDataTransfer(e.dataTransfer);
                }
              : undefined
          }
        >
          <AttachmentTray items={imageAttachments.items} onRemove={imageAttachments.remove} />
          <Textarea
            ref={composerRef}
            value={steerText}
            onChange={(e) => setSteerText(e.target.value)}
            onPaste={(e) => imageAttachments.handlePaste(e, canAttachImages)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !isComposingEvent(e)) {
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
                      ? steerWhileRunning
                        ? 'Steer the live run — delivered before the next model call…'
                        : 'Agent is busy — your message will be queued…'
                      : 'Steer the agent — add context, change direction, ask a question…'
            }
            className="min-h-[44px] resize-none border-0 shadow-none bg-transparent focus-visible:ring-0 focus-visible:border-0 text-body"
          />
          <div className="flex items-center justify-between gap-2 px-3 pb-2">
            <div className="flex items-center gap-3 min-w-0 flex-wrap">
              {canAttachImages && (
                <AttachButton
                  onFiles={(files) => void imageAttachments.addFiles(files)}
                  disabled={steerDisabled}
                  className="-ml-1"
                />
              )}
              <span className="flex items-center gap-1.5 text-ui text-muted-foreground">
                <span className="size-1.5 rounded-full bg-primary" />
                {modelName}
              </span>
              <ContextUsageButton usage={contextUsage} />
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              {isRunning && (
                <Button
                  size="icon"
                  variant="destructive"
                  aria-label="Stop session"
                  onClick={() => {
                    if (session.supportsInterrupt && onInterrupt) void onInterrupt();
                    else void onPause();
                  }}
                  disabled={lifecycleBusy}
                  className="shrink-0 rounded-full"
                >
                  <Square className="size-3.5" />
                </Button>
              )}
              <Button
                size="icon"
                aria-label="Send"
                onClick={() => void handleSteer()}
                disabled={steerDisabled || (!steerText.trim() && imageAttachments.items.length === 0)}
                className="shrink-0 rounded-full transition-transform active:scale-95 disabled:opacity-40"
              >
                <Send className="size-4" />
              </Button>
            </div>
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
      )}

      </div>

      {!managedByCrew && (panelOpen || terminalMounted) && (
        <aside
          className={
            activeTool === 'browser'
              ? 'w-[520px] max-w-[48vw] shrink-0 border-l border-border bg-card/40 flex flex-col min-h-0'
              : 'w-[360px] shrink-0 border-l border-border bg-card/40 flex flex-col min-h-0'
          }
          style={panelOpen ? undefined : { display: 'none' }}
        >
          {panelOpen && (
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
          )}

          {panelOpen && activeTool === 'scm' && hasGitContext && (
            <div className="flex-1 min-h-0">
              <ScmPanel
                session={session}
                workingDir={workingDir}
                segment={scmSegment}
                onSegmentChange={setScmSegment}
              />
            </div>
          )}

          {panelOpen && activeTool === 'files' && fileExplorerMounted && (
            <div className="flex-1 min-h-0">
              <FileExplorerPanel root={workingDir} openPath={fileExplorerOpenPath} />
            </div>
          )}

          {panelOpen && activeTool === 'browser' && (
            <div className="flex-1 min-h-0">
              <BrowserPanel sessionId={session.id} />
            </div>
          )}

          {terminalMounted && (
            <div
              className="flex-1 min-h-0 bg-card/60"
              style={panelOpen && activeTool === 'terminal' ? undefined : { display: 'none' }}
            >
              <ChunkErrorBoundary>
                <Suspense fallback={null}>
                  <TerminalDock cwd={workingDir} />
                </Suspense>
              </ChunkErrorBoundary>
            </div>
          )}
        </aside>
      )}
      </TooltipProvider>

      <Dialog open={!managedByCrew && confirmDelete} onOpenChange={setConfirmDelete}>
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

async function openExternalBrowser(url: string) {
  const desktopExternal = window.nuncioDesktop?.external;
  if (desktopExternal) {
    await desktopExternal.open(url);
    return;
  }
  window.open(url, '_blank', 'noopener,noreferrer');
}
