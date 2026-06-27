import { useCallback, useEffect, useState } from 'react';
import { Menu } from 'lucide-react';
import { toast } from 'sonner';
import {
  archiveSession,
  createSession,
  fetchModels,
  fetchSessions,
  pauseSession,
  steerSession,
  type Session,
} from './lib/api';
import { clearSetting, fetchSettings, updateSetting, type Setting } from './lib/settings-api';
import { useSessionStream } from './lib/use-session-stream';
import { HomeView } from './components/home-view';
import { SessionDetail } from './components/session-detail';
import { SettingsView } from './components/settings-view';
import { Sidebar } from './components/sidebar';
import type { ModelProvider } from './lib/model-providers';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';
import { Toaster } from '@/components/ui/sonner';

export default function App() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [providers, setProviders] = useState<ModelProvider[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [steering, setSteering] = useState(false);
  const [lifecycleBusy, setLifecycleBusy] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [settings, setSettings] = useState<Setting[]>([]);
  const events = useSessionStream(activeId);

  const refresh = useCallback(async () => {
    const list = await fetchSessions();
    setSessions(list);
    return list;
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
    const timer = setInterval(() => void refresh(), 5000);
    return () => clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    void refreshModels();
  }, [refreshModels]);

  const activeSession = sessions.find((s) => s.id === activeId) ?? null;

  const handleSelect = useCallback((id: string | null) => {
    setActiveId(id);
    setSidebarOpen(false);
  }, []);

  const handleNew = useCallback(() => {
    setActiveId(null);
    setSidebarOpen(false);
  }, []);

  const handleCreate = async (
    prompt: string,
    model?: string,
    provider?: string,
    projectPath?: string,
    baseBranch?: string,
  ) => {
    setCreating(true);
    try {
      const session = await createSession(prompt, model, provider, projectPath, baseBranch);
      const list = await refresh();
      setActiveId(session.id);
      setSidebarOpen(false);
      if (!list.find((s) => s.id === session.id)) {
        setSessions((prev) => [session, ...prev]);
      }
    } finally {
      setCreating(false);
    }
  };

  const handleSteer = async (message: string) => {
    if (!activeId) return;
    setSteering(true);
    try {
      await steerSession(activeId, message);
      await refresh();
    } finally {
      setSteering(false);
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

  const handleArchive = async () => {
    if (!activeId) return;
    setLifecycleBusy(true);
    try {
      await archiveSession(activeId);
      await refresh();
      setActiveId(null);
      setSidebarOpen(false);
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

  const handleOpenSettings = useCallback(() => {
    setShowSettings(true);
    setActiveId(null);
    setSidebarOpen(false);
    void refreshSettings();
  }, [refreshSettings]);

  const handleBackFromSettings = useCallback(() => {
    setShowSettings(false);
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

  return (
    <div className="h-full flex bg-background">
      <aside className="hidden md:flex w-[260px] shrink-0 border-r border-sidebar-border flex-col">
        <Sidebar
          sessions={sessions}
          activeId={activeId}
          onSelect={handleSelect}
          onNew={handleNew}
          onSettings={handleOpenSettings}
        />
      </aside>

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
          <Sidebar
            sessions={sessions}
            activeId={activeId}
            onSelect={handleSelect}
            onNew={handleNew}
            onSettings={handleOpenSettings}
          />
        </SheetContent>
      </Sheet>

      <main className="flex-1 flex flex-col min-h-0 min-w-0">
        {showSettings ? (
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
            steering={steering}
            lifecycleBusy={lifecycleBusy}
          />
        ) : (
          <HomeView
            sessionCount={sessions.length}
            providers={providers}
            onSubmit={handleCreate}
            loading={creating}
          />
        )}
      </main>

      <Toaster richColors closeButton />
    </div>
  );
}
