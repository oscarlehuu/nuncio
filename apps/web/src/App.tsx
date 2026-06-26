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

  const handleCreate = async (prompt: string) => {
    setCreating(true);
    try {
      const session = await createSession(prompt);
      const list = await refresh();
      setActiveId(session.id);
      if (!list.find((s) => s.id === session.id)) {
        setSessions((prev) => [session, ...prev]);
      }
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="h-full grid md:grid-cols-[260px_1fr] bg-bg-0">
      <Sidebar
        sessions={sessions}
        activeId={activeId}
        onSelect={setActiveId}
        onNew={() => setActiveId(null)}
      />
      <main className="flex flex-col min-h-0 min-w-0">
        {activeSession ? (
          <SessionDetail
            session={activeSession}
            events={events}
            onBack={() => setActiveId(null)}
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
