import { useCallback, useEffect, useState } from 'react';
import { Menu } from 'lucide-react';
import {
  archiveSession,
  createSession,
  fetchSessions,
  pauseSession,
  steerSession,
  type Session,
} from './lib/api';
import { useSessionStream } from './lib/use-session-stream';
import { HomeView } from './components/home-view';
import { SessionDetail } from './components/session-detail';
import { Sidebar } from './components/sidebar';
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
  const [activeId, setActiveId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [steering, setSteering] = useState(false);
  const [lifecycleBusy, setLifecycleBusy] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const events = useSessionStream(activeId);

  const refresh = useCallback(async () => {
    const list = await fetchSessions();
    setSessions(list);
    return list;
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    return () => clearInterval(timer);
  }, [refresh]);

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

  return (
    <div className="h-full flex bg-background">
      <aside className="hidden md:flex w-[260px] shrink-0 border-r border-sidebar-border flex-col">
        <Sidebar
          sessions={sessions}
          activeId={activeId}
          onSelect={handleSelect}
          onNew={handleNew}
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
        <SheetContent side="left" className="w-[280px] p-0 gap-0">
          <SheetTitle className="sr-only">Navigation</SheetTitle>
          <Sidebar
            sessions={sessions}
            activeId={activeId}
            onSelect={handleSelect}
            onNew={handleNew}
          />
        </SheetContent>
      </Sheet>

      <main className="flex-1 flex flex-col min-h-0 min-w-0">
        {activeSession ? (
          <SessionDetail
            session={activeSession}
            events={events}
            onBack={handleNew}
            onSteer={handleSteer}
            onPause={handlePause}
            onArchive={handleArchive}
            steering={steering}
            lifecycleBusy={lifecycleBusy}
          />
        ) : (
          <HomeView
            sessionCount={sessions.length}
            onSubmit={handleCreate}
            loading={creating}
          />
        )}
      </main>

      <Toaster richColors closeButton />
    </div>
  );
}
