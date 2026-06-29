import { useCallback, useEffect, useRef, useState } from 'react';
import { Menu } from 'lucide-react';
import { toast } from 'sonner';
import {
  archiveSession,
  createSession,
  deleteSession,
  fetchArchivedSessions,
  fetchModels,
  fetchSessions,
  pauseSession,
  respondProviderRequest,
  restoreSession,
  steerSession,
  type ProviderRequestDecision,
  type Session,
} from './lib/api';
import { clearSetting, fetchSettings, updateSetting, type Setting } from './lib/settings-api';
import { useSessionStream } from './lib/use-session-stream';
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
  const [sessions, setSessions] = useState<Session[]>([]);
  const [archivedSessions, setArchivedSessions] = useState<Session[]>([]);
  const [providers, setProviders] = useState<ModelProvider[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [steering, setSteering] = useState(false);
  const [lifecycleBusy, setLifecycleBusy] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const desktopSidebar = useDesktopSidebar();
  const [showSettings, setShowSettings] = useState(false);
  const [showChangelog, setShowChangelog] = useState(false);
  const [handoffOpen, setHandoffOpen] = useState(false);
  const [handoffInitialWorkspace, setHandoffInitialWorkspace] = useState<string | undefined>();
  const [settings, setSettings] = useState<Setting[]>([]);
  const approvalMode: ApprovalMode =
    settings.find((setting) => setting.key === 'NUNCIO_CODEX_RUNTIME_MODE')?.value ===
    'approval-required'
      ? 'approval-required'
      : 'full-access';
  const events = useSessionStream(activeId);
  const steerRequestSeq = useRef(0);
  // Suppress repeated toast spam when the server is unreachable: only toast
  // the *first* failure of each kind, then stay quiet until the next success
  // resets the flag. The 5s polling interval would otherwise fire a toast on
  // every tick while the server is down/restarting.
  const sessionsErrorShown = useRef(false);
  const archivedErrorShown = useRef(false);

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
    void refresh();
    void refreshArchived();
    const timer = setInterval(() => {
      void refresh();
      void refreshArchived();
    }, 5000);
    return () => clearInterval(timer);
  }, [refresh, refreshArchived]);

  useEffect(() => {
    void refreshModels();
  }, [refreshModels]);

  const activeSession = sessions.find((s) => s.id === activeId) ?? null;

  useEffect(() => {
    if (!activeId) return;
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

    setSessions((prev) => {
      let changed = false;
      const next = prev.map((session) => {
        if (session.id !== activeId) return session;
        const updatedAt = Math.max(session.updatedAt, createdAt);
        if (session.status === status && session.updatedAt === updatedAt) return session;
        changed = true;
        return { ...session, status, updatedAt };
      });
      return changed ? next : prev;
    });

    if (status !== 'RUNNING') setSteering(false);
  }, [activeId, events]);

  const dismissTransientSidebar = useCallback(() => {
    setSidebarOpen(false);
    desktopSidebar.closeHover();
  }, [desktopSidebar]);

  const handleSelect = useCallback(
    (id: string | null) => {
      setActiveId(id);
      dismissTransientSidebar();
    },
    [dismissTransientSidebar],
  );

  const handleNew = useCallback(() => {
    setActiveId(null);
    dismissTransientSidebar();
  }, [dismissTransientSidebar]);

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
      setActiveId(session.id);
      dismissTransientSidebar();
      if (!list?.find((s) => s.id === session.id)) {
        setSessions((prev) => [session, ...prev]);
      }
    } finally {
      setCreating(false);
    }
  };

  const handleSteer = async (message: string) => {
    if (!activeId) return;
    const requestSeq = steerRequestSeq.current + 1;
    steerRequestSeq.current = requestSeq;
    setSteering(true);
    try {
      await steerSession(activeId, message);
      await refresh();
    } finally {
      if (steerRequestSeq.current === requestSeq) setSteering(false);
    }
  };

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
        setActiveId(null);
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
      if (activeId === id) setActiveId(null);
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
    setShowSettings(true);
    setShowChangelog(false);
    setActiveId(null);
    dismissTransientSidebar();
    void refreshSettings();
  }, [dismissTransientSidebar, refreshSettings]);

  const handleBackFromSettings = useCallback(() => {
    setShowSettings(false);
  }, []);

  const handleOpenChangelog = useCallback(() => {
    setShowChangelog(true);
    setShowSettings(false);
    setActiveId(null);
    dismissTransientSidebar();
  }, [dismissTransientSidebar]);

  const handleBackFromChangelog = useCallback(() => {
    setShowChangelog(false);
  }, []);

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
      setActiveId(sessionId);
      dismissTransientSidebar();
    },
    [refresh, dismissTransientSidebar],
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
        {showChangelog ? (
          <ChangelogView onBack={handleBackFromChangelog} />
        ) : showSettings ? (
          <SettingsView
            settings={settings}
            onUpdate={handleUpdateSetting}
            onClear={handleClearSetting}
            onBack={handleBackFromSettings}
          />
        ) : activeSession ? (
          <SessionDetail
            session={activeSession}
            events={events}
            providers={providers}
            onSteer={handleSteer}
            onPause={handlePause}
            onArchive={handleArchive}
            onRestore={handleRestore}
            onDelete={handleDelete}
            onContinueOnMobile={() =>
              openHandoff(activeSession.projectPath ?? activeSession.workspace ?? undefined)
            }
            approvalMode={approvalMode}
            onApprovalModeChange={handleApprovalModeChange}
            onRespondProviderRequest={handleRespondProviderRequest}
            steering={steering}
            lifecycleBusy={lifecycleBusy}
          />
        ) : (
          <HomeView
            sessionCount={sessions.length}
            providers={providers}
            onSubmit={handleCreate}
            onContinueOnMobile={() => openHandoff()}
            approvalMode={approvalMode}
            onApprovalModeChange={handleApprovalModeChange}
            loading={creating}
          />
        )}
      </main>

      <HandoffPicker
        open={handoffOpen}
        onOpenChange={handleHandoffOpenChange}
        onImported={(id) => void handleHandoffImported(id)}
        initialWorkspace={handoffInitialWorkspace}
      />

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
