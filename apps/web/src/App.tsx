import { useCallback, useEffect, useState } from 'react';
import {
  createSession,
  fetchSessions,
  type Session,
} from './lib/api';
import { useSessionStream } from './lib/use-session-stream';
import { HomeView } from './components/home-view';
import { SessionDetail } from './components/session-detail';
import { Sidebar } from './components/sidebar';

export default function App() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
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

  const closeSidebar = useCallback(() => setSidebarOpen(false), []);

  const handleSelect = useCallback(
    (id: string | null) => {
      setActiveId(id);
      closeSidebar();
    },
    [closeSidebar],
  );

  const handleNew = useCallback(() => {
    setActiveId(null);
    closeSidebar();
  }, [closeSidebar]);

  const handleCreate = async (prompt: string) => {
    setCreating(true);
    try {
      const session = await createSession(prompt);
      const list = await refresh();
      setActiveId(session.id);
      closeSidebar();
      if (!list.find((s) => s.id === session.id)) {
        setSessions((prev) => [session, ...prev]);
      }
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="h-full grid md:grid-cols-[260px_1fr] bg-bg-0">
      <button
        type="button"
        className="mobile-toggle"
        aria-label="Menu"
        aria-expanded={sidebarOpen}
        onClick={() => setSidebarOpen((open) => !open)}
      >
        <MenuIcon />
      </button>
      <div
        className={`scrim${sidebarOpen ? ' show' : ''}`}
        onClick={closeSidebar}
        role="presentation"
      />
      <Sidebar
        sessions={sessions}
        activeId={activeId}
        open={sidebarOpen}
        onSelect={handleSelect}
        onNew={handleNew}
      />
      <main className="flex flex-col min-h-0 min-w-0">
        {activeSession ? (
          <SessionDetail
            session={activeSession}
            events={events}
            onBack={handleNew}
          />
        ) : (
          <HomeView
            sessionCount={sessions.length}
            onSubmit={handleCreate}
            loading={creating}
          />
        )}
      </main>
    </div>
  );
}

function MenuIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="w-5 h-5">
      <line x1="3" y1="6" x2="21" y2="6" />
      <line x1="3" y1="12" x2="21" y2="12" />
      <line x1="3" y1="18" x2="21" y2="18" />
    </svg>
  );
}
