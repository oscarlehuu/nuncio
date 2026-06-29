import { useCallback, useEffect, useRef, useState } from 'react';
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
  pauseSession,
  renameSession,
  respondProviderRequest,
  restoreSession,
  steerSession,
  SteerApiError,
  type ProviderRequestDecision,
  type Session,
} from './lib/api';
import { clearSetting, fetchSettings, updateSetting, type Setting } from './lib/settings-api';
import { useSessionStream } from './lib/use-session-stream';
import { useActiveRun } from './lib/use-active-run';
import { HomeView } from './components/home-view';
import type { ApprovalMode } from './components/approval-mode-picker';
import { HandoffPicker } from './components/handoff-picker';
import { ChangelogView } from './components/changelog-view';
import { DesktopSidebarHoverRail, DesktopSidebarPinned } from './components/desktop-sidebar-shell';
import { SessionDetail } from './components/session-detail';
import { SettingsView } from './components/settings-view';
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

  const handleSteer = async (message: string, options?: { forceResume?: boolean }) => {
    if (!activeId) return;
    setSteering(true);
    try {
      await steerSession(activeId, message, options?.forceResume);
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
      setSteering(false);
    }
  };

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

    if (id === activeId && status !== 'RUNNING') setSteering(false);
  }, [activeId]);

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
    onSettings: handleOpenSettings,
    onChangelog: handleOpenChangelog,
    onArchive: handleArchiveById,
    onRestore: handleRestore,
    onDelete: handleDelete,
  };

  return (
    <div className="h-full flex bg-background">
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
              <SettingsView
                settings={settings}
                onUpdate={handleUpdateSetting}
                onClear={handleClearSetting}
                onBack={() => navigate('/')}
              />
            }
          />
          <Route path="/changelog" element={<ChangelogView onBack={() => navigate('/')} />} />
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
                if (msg) void handleSteer(msg, { forceResume: true });
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
  onSteer: (message: string, options?: { forceResume?: boolean }) => Promise<void>;
  onPause: () => Promise<void>;
  onArchive: () => Promise<void>;
  onRestore: (id: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onRename: (id: string, title: string) => Promise<void>;
  onContinueOnMobile: (workspace?: string) => void;
  steering: boolean;
  lifecycleBusy: boolean;
  onSessionLoaded: (session: Session) => void;
  onSessionStatus: (id: string, status: Session['status'], createdAt: number) => void;
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
  onArchive,
  onRestore,
  onDelete,
  onRename,
  onContinueOnMobile,
  steering,
  lifecycleBusy,
  onSessionLoaded,
  onSessionStatus,
  onMissingSession,
}: SessionRouteProps) {
  const { sessionId } = useParams();
  const [fetchedSession, setFetchedSession] = useState<Session | null>(null);
  const missingHandled = useRef(false);

  const listedSession =
    sessions.find((s) => s.id === sessionId) ??
    archivedSessions.find((s) => s.id === sessionId) ??
    null;
  const session = listedSession ?? fetchedSession;
  const { events, refetch } = useSessionStream(session?.id ?? null);
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
    let createdAt = Date.now();
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const event = events[i];
      if (event?.type !== 'status') continue;
      status = asSessionStatus(event.payload.status);
      createdAt = event.createdAt;
      break;
    }
    if (!status) return;
    onSessionStatus(session.id, status, createdAt);
  }, [events, onSessionStatus, session]);

  if (!session) return null;

  return (
    <SessionDetail
      session={session}
      events={events}
      providers={providers}
      onSteer={onSteer}
      onPause={onPause}
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
      steering={steering}
      lifecycleBusy={lifecycleBusy}
      machineActive={machineActive}
    />
  );
}
