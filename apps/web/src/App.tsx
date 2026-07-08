import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { Menu } from 'lucide-react';
import { matchPath, Navigate, Route, Routes, useLocation, useNavigate, useParams } from 'react-router-dom';
import { toast } from 'sonner';
import {
  archiveSession,
  createSession,
  deleteSession,
  fetchArchivedSessions,
  fetchModels,
  fetchSession,
  fetchSessions,
  interruptSession,
  pauseSession,
  renameSession,
  respondProviderRequest,
  restoreSession,
  steerSession,
  SteerApiError,
  type MessageAttachment,
  type ProviderRequestDecision,
  type Session,
} from './lib/api';
import { clearSetting, fetchSettings, updateSetting, type Setting } from './lib/settings-api';
import { DETAIL_EVENT_TAIL, useSessionStream } from './lib/use-session-stream';
import { useActiveRun } from './lib/use-active-run';
import { useSessionNotifications } from './lib/use-session-notifications';
import { useProviderUpdateNotifications } from './lib/use-provider-update-notifications';
import { HomeView } from './components/home-view';
import { GridView } from './components/grid-view';
import { ChunkErrorBoundary } from './components/chunk-error-boundary';
import type { ApprovalMode } from './components/approval-mode-picker';
import { HandoffPicker } from './components/handoff-picker';
import { DesktopSidebarHoverRail, DesktopSidebarPinned } from './components/desktop-sidebar-shell';
import { SessionDetail } from './components/session-detail';
import { Sidebar } from './components/sidebar';
import type { ModelProvider } from './lib/model-providers';
import type { ModelOptionsMap } from './lib/model-options';
import { useDesktopSidebar } from './lib/use-desktop-sidebar';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';
import { Toaster } from '@/components/ui/sonner';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

// Lazy routes: settings and changelog are rarely visited and the changelog
// bundles the full CHANGELOG.md text — keep both out of the entry chunk.
const SettingsView = lazy(() =>
  import('./components/settings-view').then((m) => ({ default: m.SettingsView })),
);
const ChangelogView = lazy(() =>
  import('./components/changelog-view').then((m) => ({ default: m.ChangelogView })),
);

function sessionIdFromPath(pathname: string): string | null {
  return matchPath('/session/:sessionId', pathname)?.params.sessionId ?? null;
}

const SESSION_STATUSES: readonly Session['status'][] = [
  'CREATED',
  'RUNNING',
  'IDLE',
  'PAUSED',
  'ARCHIVED',
  'ERROR',
];

function asSessionStatus(value: unknown): Session['status'] | null {
  if (typeof value !== 'string') return null;
  return (SESSION_STATUSES as readonly string[]).includes(value)
    ? (value as Session['status'])
    : null;
}

function asSessionTitle(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const title = (payload as { title?: unknown }).title;
  return typeof title === 'string' && title.trim() ? title.trim() : null;
}

function applySessionTitle(
  list: Session[],
  id: string,
  title: string,
  createdAt: number,
): Session[] {
  let changed = false;
  const next = list.map((session) => {
    if (session.id !== id) return session;
    const updatedAt = Math.max(session.updatedAt, createdAt);
    if (session.title === title && session.updatedAt === updatedAt) return session;
    changed = true;
    return { ...session, title, updatedAt };
  });
  return changed ? next : list;
}

export default function App() {
  const navigate = useNavigate();
  const location = useLocation();
  const activeId = sessionIdFromPath(location.pathname);

  const [sessions, setSessions] = useState<Session[]>([]);
  const [archivedSessions, setArchivedSessions] = useState<Session[]>([]);
  const [providers, setProviders] = useState<ModelProvider[]>([]);
  const [creating, setCreating] = useState(false);
  const [steering, setSteering] = useState(false);
  const [lifecycleBusy, setLifecycleBusy] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const desktopSidebar = useDesktopSidebar();
  const [handoffOpen, setHandoffOpen] = useState(false);
  const [handoffInitialWorkspace, setHandoffInitialWorkspace] = useState<string | undefined>();
  const [forceSteerMessage, setForceSteerMessage] = useState<string | null>(null);
  const [settings, setSettings] = useState<Setting[]>([]);
  const [listsReady, setListsReady] = useState(false);
  const sessionsErrorShown = useRef(false);
  const archivedErrorShown = useRef(false);
  const steeringSessionIdRef = useRef<string | null>(null);
  const steeringTokenRef = useRef(0);
  const approvalMode: ApprovalMode =
    settings.find((setting) => setting.key === 'NUNCIO_CODEX_RUNTIME_MODE')?.value ===
    'approval-required'
      ? 'approval-required'
      : 'full-access';

  const refresh = useCallback(async () => {
    try {
      const list = await fetchSessions();
      setSessions(list);
      sessionsErrorShown.current = false;
      return list;
    } catch {
      if (!sessionsErrorShown.current) {
        toast.error('Failed to load sessions');
        sessionsErrorShown.current = true;
      }
      return undefined;
    }
  }, []);

  const refreshArchived = useCallback(async () => {
    try {
      const list = await fetchArchivedSessions();
      setArchivedSessions(list);
      archivedErrorShown.current = false;
    } catch {
      if (!archivedErrorShown.current) {
        toast.error('Failed to load archived sessions');
        archivedErrorShown.current = true;
      }
    }
  }, []);

  const refreshModels = useCallback(async () => {
    try {
      const list = await fetchModels();
      setProviders(list);
    } catch {
      toast.error('Failed to load models');
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([refresh(), refreshArchived()]).finally(() => {
      if (!cancelled) setListsReady(true);
    });
    const timer = setInterval(() => {
      void refresh();
      void refreshArchived();
    }, 5000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [refresh, refreshArchived]);

  useEffect(() => {
    void refreshModels();
  }, [refreshModels]);

  // Land in the work, not a blank canvas: on first load (desktop, with sessions)
  // open straight to the Workbench instead of the empty composer home. One-shot —
  // it never yanks the user later, and "New Agent" (→ '/') still reaches the composer.
  const initialLandingDone = useRef(false);
  useEffect(() => {
    if (initialLandingDone.current || !listsReady) return;
    initialLandingDone.current = true;
    const isDesktop = window.matchMedia('(min-width: 768px)').matches;
    if (isDesktop && sessions.length > 0 && location.pathname === '/') {
      navigate('/grid', { replace: true });
    }
  }, [listsReady, sessions.length, location.pathname, navigate]);

  const reviewProviderUpdates = useCallback(() => navigate('/settings'), [navigate]);

  useSessionNotifications(sessions, activeId);
  useProviderUpdateNotifications(reviewProviderUpdates);

  const dismissTransientSidebar = useCallback(() => {
    setSidebarOpen(false);
    desktopSidebar.closeHover();
  }, [desktopSidebar]);

  const handleSelect = useCallback(
    (id: string | null) => {
      navigate(id ? `/session/${id}` : '/');
      dismissTransientSidebar();
    },
    [dismissTransientSidebar, navigate],
  );

  const handleNew = useCallback(() => {
    navigate('/');
    dismissTransientSidebar();
  }, [dismissTransientSidebar, navigate]);

  const handleCreate = async (
    prompt: string,
    model?: string,
    provider?: string,
    projectPath?: string,
    baseBranch?: string,
    modelOptions?: ModelOptionsMap,
    useWorktree = false,
    attachments?: MessageAttachment[],
  ) => {
    setCreating(true);
    try {
      const session = await createSession(
        prompt,
        model,
        provider,
        projectPath,
        baseBranch,
        modelOptions,
        useWorktree,
        '',
        attachments,
      );
      const list = await refresh();
      navigate(`/session/${session.id}`);
      dismissTransientSidebar();
      if (!list?.find((s) => s.id === session.id)) {
        setSessions((prev) => [session, ...prev]);
      }
    } finally {
      setCreating(false);
    }
  };

  const handleSteer = async (
    message: string,
    attachments?: MessageAttachment[],
    options?: { forceResume?: boolean },
  ) => {
    if (!activeId) return;
    const token = steeringTokenRef.current + 1;
    steeringTokenRef.current = token;
    steeringSessionIdRef.current = activeId;
    setSteering(true);
    try {
      await steerSession(activeId, message, options?.forceResume, undefined, attachments);
      setForceSteerMessage(null);
      await refresh();
    } catch (err) {
      if (err instanceof SteerApiError && err.status === 409 && !options?.forceResume) {
        setForceSteerMessage(message);
        toast.error(err.message);
      } else {
        toast.error(
          err instanceof SteerApiError ? err.message : 'Failed to steer session',
        );
      }
    } finally {
      if (steeringTokenRef.current === token) {
        steeringSessionIdRef.current = null;
        setSteering(false);
      }
    }
  };

  // Grid steers a specific tile, not the global active route id.
  const handleSteerSession = useCallback(async (
    id: string,
    message: string,
    attachments?: MessageAttachment[],
  ) => {
    const token = steeringTokenRef.current + 1;
    steeringTokenRef.current = token;
    steeringSessionIdRef.current = id;
    setSteering(true);
    try {
      await steerSession(id, message, undefined, undefined, attachments);
      await refresh();
    } catch (err) {
      toast.error(err instanceof SteerApiError ? err.message : 'Failed to steer session');
    } finally {
      if (steeringTokenRef.current === token) {
        steeringSessionIdRef.current = null;
        setSteering(false);
      }
    }
  }, [refresh]);

  const handlePauseSession = useCallback(async (id: string) => {
    setLifecycleBusy(true);
    try {
      await pauseSession(id);
      await refresh();
    } finally {
      setLifecycleBusy(false);
    }
  }, [refresh]);

  // Grid needs the created session back to bind the slot; unlike handleCreate it
  // does not navigate away from the grid route.
  const handleCreateReturning = useCallback(
    async (
      prompt: string,
      model?: string,
      provider?: string,
      projectPath?: string,
      baseBranch?: string,
      modelOptions?: ModelOptionsMap,
      useWorktree?: boolean,
      attachments?: MessageAttachment[],
    ): Promise<Session | null> => {
      setCreating(true);
      try {
        const session = await createSession(
          prompt,
          model,
          provider,
          projectPath,
          baseBranch,
          modelOptions,
          useWorktree ?? false,
          '',
          attachments,
        );
        const list = await refresh();
        if (!list?.find((s) => s.id === session.id)) {
          setSessions((prev) => [session, ...prev]);
        }
        return session;
      } catch {
        toast.error('Failed to create session');
        return null;
      } finally {
        setCreating(false);
      }
    },
    [refresh],
  );

  const handleSessionStatus = useCallback((id: string, status: Session['status'], createdAt: number) => {
    setSessions((prev) => {
      let changed = false;
      const next = prev.map((session) => {
        if (session.id !== id) return session;
        const updatedAt = Math.max(session.updatedAt, createdAt);
        if (session.status === status && session.updatedAt === updatedAt) return session;
        changed = true;
        return { ...session, status, updatedAt };
      });
      return changed ? next : prev;
    });

    if (status !== 'RUNNING' && (id === activeId || id === steeringSessionIdRef.current)) {
      steeringSessionIdRef.current = null;
      setSteering(false);
    }
  }, [activeId]);

  const handleSessionTitle = useCallback((id: string, title: string, createdAt: number) => {
    setSessions((prev) => applySessionTitle(prev, id, title, createdAt));
    setArchivedSessions((prev) => applySessionTitle(prev, id, title, createdAt));
  }, []);

  const handlePause = async () => {
    if (!activeId) return;
    setLifecycleBusy(true);
    try {
      await pauseSession(activeId);
      await refresh();
    } finally {
      setLifecycleBusy(false);
    }
  };

  const handleInterrupt = async () => {
    if (!activeId) return;
    setLifecycleBusy(true);
    try {
      await interruptSession(activeId);
      await refresh();
    } catch {
      toast.error('Failed to stop the run');
    } finally {
      setLifecycleBusy(false);
    }
  };

  const handleArchiveById = async (id: string) => {
    setLifecycleBusy(true);
    try {
      await archiveSession(id);
      await Promise.all([refresh(), refreshArchived()]);
      if (activeId === id) {
        navigate('/');
        dismissTransientSidebar();
      }
    } catch {
      toast.error('Failed to archive session');
    } finally {
      setLifecycleBusy(false);
    }
  };

  const handleArchive = async () => {
    if (!activeId) return;
    await handleArchiveById(activeId);
  };

  const handleRename = useCallback(
    async (id: string, title: string) => {
      try {
        await renameSession(id, title);
        await refresh();
      } catch {
        toast.error('Failed to rename session');
      }
    },
    [refresh],
  );

  const handleRestore = async (id: string) => {
    setLifecycleBusy(true);
    try {
      await restoreSession(id);
      await Promise.all([refresh(), refreshArchived()]);
      toast.success('Session restored');
    } catch {
      toast.error('Failed to restore session');
    } finally {
      setLifecycleBusy(false);
    }
  };

  const handleDelete = async (id: string) => {
    setLifecycleBusy(true);
    try {
      await deleteSession(id);
      if (activeId === id) navigate('/');
      await Promise.all([refresh(), refreshArchived()]);
      toast.success('Session deleted');
    } catch {
      toast.error('Failed to delete session');
    } finally {
      setLifecycleBusy(false);
    }
  };

  const refreshSettings = useCallback(async () => {
    try {
      const list = await fetchSettings();
      setSettings(list);
    } catch {
      toast.error('Failed to load settings');
    }
  }, []);

  useEffect(() => {
    void refreshSettings();
  }, [refreshSettings]);

  const handleOpenGrid = useCallback(() => {
    navigate('/grid');
    dismissTransientSidebar();
  }, [dismissTransientSidebar, navigate]);

  const handleOpenSettings = useCallback(() => {
    navigate('/settings');
    dismissTransientSidebar();
    void refreshSettings();
  }, [dismissTransientSidebar, navigate, refreshSettings]);

  const handleOpenChangelog = useCallback(() => {
    navigate('/changelog');
    dismissTransientSidebar();
  }, [dismissTransientSidebar, navigate]);

  const handleUpdateSetting = useCallback(
    async (key: string, value: string) => {
      try {
        const updated = await updateSetting(key, value);
        setSettings((prev) => prev.map((s) => (s.key === key ? updated : s)));
        await refreshModels();
        toast.success(`Saved ${key}`);
      } catch {
        toast.error(`Failed to save ${key}`);
      }
    },
    [refreshModels],
  );

  const handleClearSetting = useCallback(async (key: string) => {
    try {
      const updated = await clearSetting(key);
      setSettings((prev) => prev.map((s) => (s.key === key ? updated : s)));
      await refreshModels();
      toast.success(`Cleared ${key}`);
    } catch {
      toast.error(`Failed to clear ${key}`);
    }
  }, [refreshModels]);

  const handleApprovalModeChange = useCallback(async (mode: ApprovalMode) => {
    try {
      const updated = await updateSetting('NUNCIO_CODEX_RUNTIME_MODE', mode);
      setSettings((prev) =>
        prev.some((s) => s.key === updated.key)
          ? prev.map((s) => (s.key === updated.key ? updated : s))
          : [...prev, updated],
      );
      toast.success(`Saved ${updated.label}`);
    } catch {
      toast.error('Failed to save approval mode');
    }
  }, []);

  const handleRespondProviderRequest = useCallback(
    async (requestId: string, decision: ProviderRequestDecision) => {
      if (!activeId) return;
      try {
        await respondProviderRequest(activeId, requestId, decision);
      } catch {
        toast.error('Failed to respond to provider request');
      }
    },
    [activeId],
  );

  const openHandoff = useCallback((workspace?: string) => {
    setHandoffInitialWorkspace(workspace);
    setHandoffOpen(true);
  }, []);

  const handleHandoffOpenChange = useCallback((open: boolean) => {
    setHandoffOpen(open);
    if (!open) setHandoffInitialWorkspace(undefined);
  }, []);

  const handleHandoffImported = useCallback(
    async (sessionId: string) => {
      await refresh();
      navigate(`/session/${sessionId}`);
      dismissTransientSidebar();
    },
    [refresh, dismissTransientSidebar, navigate],
  );

  const sidebarProps = {
    sessions,
    archivedSessions,
    activeId,
    onSelect: handleSelect,
    onNew: handleNew,
    onGrid: handleOpenGrid,
    onSettings: handleOpenSettings,
    onChangelog: handleOpenChangelog,
    onArchive: handleArchiveById,
    onRestore: handleRestore,
    onDelete: handleDelete,
  };

  return (
    <div className="h-full flex bg-background app-aurora">
      {desktopSidebar.pinned ? (
        <DesktopSidebarPinned
          open={desktopSidebar.open}
          onTogglePin={desktopSidebar.togglePin}
          {...sidebarProps}
        />
      ) : null}

      <Sheet open={sidebarOpen} onOpenChange={setSidebarOpen}>
        <SheetTrigger asChild>
          <Button
            variant="outline"
            size="icon"
            className="md:hidden fixed z-50 backdrop-blur"
            style={{
              top: 'calc(12px + env(safe-area-inset-top, 0px))',
              left: 'calc(12px + env(safe-area-inset-left, 0px))',
            }}
            aria-label="Open navigation"
          >
            <Menu />
          </Button>
        </SheetTrigger>
        <SheetContent side="left" showCloseButton={false} className="w-[280px] p-0 gap-0">
          <SheetTitle className="sr-only">Navigation</SheetTitle>
          <Sidebar {...sidebarProps} />
        </SheetContent>
      </Sheet>

      <main className="flex-1 flex flex-col min-h-0 min-w-0">
        <Routes>
          <Route
            path="/"
            element={
              <HomeView
                sessionCount={sessions.length}
                providers={providers}
                onSubmit={handleCreate}
                onContinueOnMobile={() => openHandoff()}
                approvalMode={approvalMode}
                onApprovalModeChange={handleApprovalModeChange}
                loading={creating}
              />
            }
          />
          <Route
            path="/grid"
            element={
              <GridView
                sessions={sessions}
                providers={providers}
                approvalMode={approvalMode}
                onApprovalModeChange={handleApprovalModeChange}
                onRespondProviderRequest={async (id, requestId, decision) => {
                  try {
                    await respondProviderRequest(id, requestId, decision);
                  } catch {
                    toast.error('Failed to respond to provider request');
                  }
                }}
                onSteerSession={handleSteerSession}
                onPauseSession={handlePauseSession}
                onArchiveSession={handleArchiveById}
                onRestore={handleRestore}
                onDelete={handleDelete}
                onRename={handleRename}
                onSessionStatus={handleSessionStatus}
                onSessionTitle={handleSessionTitle}
                onCreate={handleCreateReturning}
                steering={steering}
                lifecycleBusy={lifecycleBusy}
                railOverlay={!desktopSidebar.pinned}
              />
            }
          />
          {/* Legacy /board → the unified Workbench (grid). */}
          <Route path="/board" element={<Navigate to="/grid" replace />} />
          <Route
            path="/session/:sessionId"
            element={
              <SessionRoute
                sessions={sessions}
                archivedSessions={archivedSessions}
                listsReady={listsReady}
                providers={providers}
                approvalMode={approvalMode}
                onApprovalModeChange={handleApprovalModeChange}
                onRespondProviderRequest={handleRespondProviderRequest}
                onSteer={handleSteer}
                onPause={handlePause}
                onInterrupt={handleInterrupt}
                onArchive={handleArchive}
                onRestore={handleRestore}
                onDelete={handleDelete}
                onRename={handleRename}
                onContinueOnMobile={openHandoff}
                steering={steering}
                lifecycleBusy={lifecycleBusy}
                onSessionLoaded={(session) => {
                  setSessions((prev) => {
                    if (prev.some((s) => s.id === session.id)) return prev;
                    return [session, ...prev];
                  });
                }}
                onSessionStatus={handleSessionStatus}
                onSessionTitle={handleSessionTitle}
                onMissingSession={() => {
                  toast.error('Session not found');
                  navigate('/', { replace: true });
                }}
              />
            }
          />
          <Route
            path="/settings"
            element={
              <ChunkErrorBoundary>
                <Suspense fallback={null}>
                  <SettingsView
                    settings={settings}
                    onUpdate={handleUpdateSetting}
                    onClear={handleClearSetting}
                    onBack={() => navigate('/')}
                  />
                </Suspense>
              </ChunkErrorBoundary>
            }
          />
          <Route
            path="/changelog"
            element={
              <ChunkErrorBoundary>
                <Suspense fallback={null}>
                  <ChangelogView onBack={() => navigate('/')} />
                </Suspense>
              </ChunkErrorBoundary>
            }
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>

      <HandoffPicker
        open={handoffOpen}
        onOpenChange={handleHandoffOpenChange}
        onImported={(id) => void handleHandoffImported(id)}
        initialWorkspace={handoffInitialWorkspace}
      />

      <Dialog
        open={forceSteerMessage != null}
        onOpenChange={(open) => {
          if (!open) setForceSteerMessage(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Cursor is still running</DialogTitle>
            <DialogDescription>
              This chat may still be active in Cursor on your Mac. Force steer anyway? This can
              conflict with the IDE agent.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setForceSteerMessage(null)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                const msg = forceSteerMessage;
                setForceSteerMessage(null);
                if (msg) void handleSteer(msg, undefined, { forceResume: true });
              }}
            >
              Force steer anyway
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {!desktopSidebar.pinned ? (
        <DesktopSidebarHoverRail
          hovered={desktopSidebar.hovered}
          open={desktopSidebar.open}
          onOpenHover={desktopSidebar.openHover}
          onScheduleCloseHover={desktopSidebar.scheduleCloseHover}
          onTogglePin={desktopSidebar.togglePin}
          {...sidebarProps}
        />
      ) : null}

      <Toaster richColors closeButton />
    </div>
  );
}

interface SessionRouteProps {
  sessions: Session[];
  archivedSessions: Session[];
  listsReady: boolean;
  providers: ModelProvider[];
  approvalMode: ApprovalMode;
  onApprovalModeChange: (mode: ApprovalMode) => void | Promise<void>;
  onRespondProviderRequest: (
    requestId: string,
    decision: ProviderRequestDecision,
  ) => void | Promise<void>;
  onSteer: (message: string, attachments?: MessageAttachment[]) => Promise<void>;
  onPause: () => Promise<void>;
  onInterrupt: () => Promise<void>;
  onArchive: () => Promise<void>;
  onRestore: (id: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onRename: (id: string, title: string) => Promise<void>;
  onContinueOnMobile: (workspace?: string) => void;
  steering: boolean;
  lifecycleBusy: boolean;
  onSessionLoaded: (session: Session) => void;
  onSessionStatus: (id: string, status: Session['status'], createdAt: number) => void;
  onSessionTitle: (id: string, title: string, createdAt: number) => void;
  onMissingSession: () => void;
}

function SessionRoute({
  sessions,
  archivedSessions,
  listsReady,
  providers,
  approvalMode,
  onApprovalModeChange,
  onRespondProviderRequest,
  onSteer,
  onPause,
  onInterrupt,
  onArchive,
  onRestore,
  onDelete,
  onRename,
  onContinueOnMobile,
  steering,
  lifecycleBusy,
  onSessionLoaded,
  onSessionStatus,
  onSessionTitle,
  onMissingSession,
}: SessionRouteProps) {
  const { sessionId } = useParams();
  const navigate = useNavigate();
  const [fetchedSession, setFetchedSession] = useState<Session | null>(null);
  const missingHandled = useRef(false);

  const listedSession =
    sessions.find((s) => s.id === sessionId) ??
    archivedSessions.find((s) => s.id === sessionId) ??
    null;
  const session = listedSession ?? fetchedSession;
  const { events, refetch, loadEarlier, hasEarlier } = useSessionStream(
    session?.id ?? null,
    '',
    DETAIL_EVENT_TAIL,
  );
  const machineActive = useActiveRun(session, { onTranscriptRefreshed: refetch });

  useEffect(() => {
    setFetchedSession(null);
    missingHandled.current = false;
  }, [sessionId]);

  useEffect(() => {
    if (!sessionId || listedSession || !listsReady) return;

    let cancelled = false;
    void fetchSession(sessionId)
      .then((loaded) => {
        if (cancelled) return;
        setFetchedSession(loaded);
        onSessionLoaded(loaded);
      })
      .catch(() => {
        if (cancelled || missingHandled.current) return;
        missingHandled.current = true;
        onMissingSession();
      });

    return () => {
      cancelled = true;
    };
  }, [sessionId, listedSession, listsReady, onMissingSession, onSessionLoaded]);

  useEffect(() => {
    if (!session) return;
    let status: Session['status'] | null = null;
    let statusCreatedAt = Date.now();
    let title: string | null = null;
    let titleCreatedAt = Date.now();
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const event = events[i];
      if (event?.type === 'status' && !status) {
        status = asSessionStatus(event.payload.status);
        statusCreatedAt = event.createdAt;
      } else if (event?.type === 'session_title' && !title) {
        title = asSessionTitle(event.payload);
        titleCreatedAt = event.createdAt;
      }
      if (status && title) break;
    }
    if (status) onSessionStatus(session.id, status, statusCreatedAt);
    if (title) {
      setFetchedSession((prev) => {
        if (!prev || prev.id !== session.id) return prev;
        const updatedAt = Math.max(prev.updatedAt, titleCreatedAt);
        if (prev.title === title && prev.updatedAt === updatedAt) return prev;
        return { ...prev, title, updatedAt };
      });
      onSessionTitle(session.id, title, titleCreatedAt);
    }
  }, [events, onSessionStatus, onSessionTitle, session]);

  if (!session) return null;

  return (
    <SessionDetail
      session={session}
      events={events}
      hasEarlier={hasEarlier}
      onLoadEarlier={loadEarlier}
      providers={providers}
      onSteer={onSteer}
      onPause={onPause}
      onInterrupt={onInterrupt}
      onArchive={onArchive}
      onRestore={onRestore}
      onDelete={onDelete}
      onRename={onRename}
      onContinueOnMobile={() =>
        onContinueOnMobile(session.projectPath ?? session.workspace ?? undefined)
      }
      approvalMode={approvalMode}
      onApprovalModeChange={onApprovalModeChange}
      onRespondProviderRequest={onRespondProviderRequest}
      onOpenSession={(childSessionId) => navigate(`/session/${childSessionId}`)}
      steering={steering}
      lifecycleBusy={lifecycleBusy}
      machineActive={machineActive}
      autoFocusComposer
    />
  );
}
